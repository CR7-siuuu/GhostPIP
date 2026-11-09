using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;

namespace GhostPiP.Engine;

public enum FrameStatus
{
    Frame,
    Oversize,
    End
}

public sealed class OutgoingQueue
{
    public const int Capacity = 256;

    private sealed class Entry(string? coalesceKey, byte[] payload)
    {
        public string? CoalesceKey { get; } = coalesceKey;
        public byte[] Payload { get; set; } = payload;
    }

    private readonly object _gate = new();
    private readonly Queue<Entry> _queue = new();
    private readonly Dictionary<string, Entry> _pendingByKey = new(StringComparer.Ordinal);
    private bool _closed;

    public int Count
    {
        get { lock (_gate) return _queue.Count; }
    }

    public static string? CoalesceKeyOf(OutgoingMessage message) => message switch
    {
        PipHoverMessage hover => "PIP_HOVER:" + hover.TabId,
        PipBoundsMessage bounds => "PIP_BOUNDS:" + bounds.TabId,
        PeekStateMessage => "PEEK_STATE",
        _ => null
    };

    /// <summary>
    /// Latest-wins for state messages (hover, bounds, peek). Everything else is queued unconditionally:
    /// intents are user actions and must reach the extension.
    /// </summary>
    public void Enqueue(OutgoingMessage message) => Enqueue(CoalesceKeyOf(message), Protocol.SerializeOutgoing(message));

    public void Enqueue(string? coalesceKey, byte[] payload)
    {
        lock (_gate)
        {
            if (_closed)
                return;

            if (coalesceKey is not null)
            {
                if (_pendingByKey.TryGetValue(coalesceKey, out var pending))
                {
                    pending.Payload = payload;
                    return;
                }
                if (_queue.Count >= Capacity)
                    return;
            }

            var entry = new Entry(coalesceKey, payload);
            _queue.Enqueue(entry);
            if (coalesceKey is not null)
                _pendingByKey[coalesceKey] = entry;
            Monitor.Pulse(_gate);
        }
    }

    public bool TryTake(int timeoutMs, out byte[]? payload)
    {
        lock (_gate)
        {
            while (_queue.Count == 0)
            {
                if (_closed || !Monitor.Wait(_gate, timeoutMs))
                {
                    payload = null;
                    return false;
                }
            }

            var entry = _queue.Dequeue();
            if (entry.CoalesceKey is not null)
                _pendingByKey.Remove(entry.CoalesceKey);
            payload = entry.Payload;
            Monitor.PulseAll(_gate);
            return true;
        }
    }

    public bool WaitEmpty(int timeoutMs)
    {
        long deadline = Environment.TickCount64 + timeoutMs;
        lock (_gate)
        {
            while (_queue.Count > 0 && !_closed)
            {
                int remaining = (int)(deadline - Environment.TickCount64);
                if (remaining <= 0 || !Monitor.Wait(_gate, remaining))
                    return _queue.Count == 0;
            }
            return true;
        }
    }

    public void Close()
    {
        lock (_gate)
        {
            _closed = true;
            _queue.Clear();
            _pendingByKey.Clear();
            Monitor.PulseAll(_gate);
        }
    }
}

public sealed class NativeMessagingHost
{
    public const int MaxFrameBytes = 256 * 1024;
    public const uint WM_APP_MESSAGE = 0x8001;
    public const uint WM_APP_EOF = 0x8002;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool PostMessageW(nint hWnd, uint msg, nint wParam, nint lParam);

    private readonly nint _targetHwnd;
    private readonly Stream _input;
    private readonly Stream _output;
    private readonly ConcurrentQueue<IncomingMessage> _incoming = new();
    private readonly OutgoingQueue _outgoing = new();
    private Thread? _readerThread;
    private Thread? _writerThread;

    public NativeMessagingHost(nint targetHwnd, Stream? input = null, Stream? output = null)
    {
        _targetHwnd = targetHwnd;
        _input = input ?? Console.OpenStandardInput();
        _output = output ?? Console.OpenStandardOutput();
    }

    public void Start()
    {
        _readerThread = new Thread(ReadLoop)
        {
            IsBackground = true,
            Name = "GhostPiP-NativeMessaging-Reader"
        };
        _writerThread = new Thread(WriteLoop)
        {
            IsBackground = true,
            Name = "GhostPiP-NativeMessaging-Writer"
        };
        _readerThread.Start();
        _writerThread.Start();
    }

    public bool TryDequeue(out IncomingMessage? message) =>
        _incoming.TryDequeue(out message);

    public void Send(OutgoingMessage message) => _outgoing.Enqueue(message);

    public void Flush(int timeoutMs) => _outgoing.WaitEmpty(timeoutMs);

    private void WriteLoop()
    {
        try
        {
            while (true)
            {
                if (!_outgoing.TryTake(Timeout.Infinite, out byte[]? payload) || payload is null)
                    return;
                WriteFrame(_output, payload);
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[GhostPiP] stdout writer stopped: {ex.Message}");
            _outgoing.Close();
        }
    }

    private void ReadLoop()
    {
        try
        {
            while (true)
            {
                FrameStatus status = ReadFrame(_input, out byte[]? frame);
                if (status == FrameStatus.End)
                    break;
                if (status == FrameStatus.Oversize || frame is null)
                {
                    Console.Error.WriteLine("[GhostPiP] skipped an invalid-length frame");
                    continue;
                }

                if (Protocol.TryParseIncoming(frame, out var msg) && msg is not null)
                {
                    _incoming.Enqueue(msg);
                    if (_targetHwnd != IntPtr.Zero)
                        PostMessageW(_targetHwnd, WM_APP_MESSAGE, IntPtr.Zero, IntPtr.Zero);
                }
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[GhostPiP] stdin reader stopped: {ex.Message}");
        }
        finally
        {
            if (_targetHwnd != IntPtr.Zero)
                PostMessageW(_targetHwnd, WM_APP_EOF, IntPtr.Zero, IntPtr.Zero);
        }
    }

    /// <summary>
    /// Reads one length-prefixed frame. An oversized or empty frame is drained and reported as
    /// <see cref="FrameStatus.Oversize"/> so one bad message never takes the engine down.
    /// </summary>
    public static FrameStatus ReadFrame(Stream input, out byte[]? payload)
    {
        payload = null;
        Span<byte> lenBuf = stackalloc byte[4];
        if (ReadExact(input, lenBuf) < 4)
            return FrameStatus.End;

        uint length = BinaryPrimitives.ReadUInt32LittleEndian(lenBuf);
        if (length == 0)
            return FrameStatus.Oversize;

        if (length > MaxFrameBytes)
            return Drain(input, length) ? FrameStatus.Oversize : FrameStatus.End;

        byte[] body = new byte[length];
        if (ReadExact(input, body) < (int)length)
            return FrameStatus.End;

        payload = body;
        return FrameStatus.Frame;
    }

    private static bool Drain(Stream input, uint length)
    {
        Span<byte> scratch = stackalloc byte[4096];
        long remaining = length;
        while (remaining > 0)
        {
            int n = input.Read(scratch[..(int)Math.Min(scratch.Length, remaining)]);
            if (n <= 0)
                return false;
            remaining -= n;
        }
        return true;
    }

    public static void WriteFrame(Stream output, ReadOnlySpan<byte> utf8Payload)
    {
        if (utf8Payload.IsEmpty || utf8Payload.Length > MaxFrameBytes)
            throw new InvalidDataException($"Invalid outgoing frame length: {utf8Payload.Length}.");

        Span<byte> lenBytes = stackalloc byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(lenBytes, (uint)utf8Payload.Length);
        output.Write(lenBytes);
        output.Write(utf8Payload);
        output.Flush();
    }

    public static void WriteMessage(Stream output, OutgoingMessage message) =>
        WriteFrame(output, Protocol.SerializeOutgoing(message));

    private static int ReadExact(Stream stream, Span<byte> buffer)
    {
        int total = 0;
        while (total < buffer.Length)
        {
            int n = stream.Read(buffer[total..]);
            if (n <= 0)
                break;
            total += n;
        }
        return total;
    }
}
