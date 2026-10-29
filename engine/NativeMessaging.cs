using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;

namespace GhostPiP.Engine;

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
    private readonly object _writeLock = new();
    private readonly ConcurrentQueue<IncomingMessage> _incoming = new();
    private Thread? _readerThread;

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
        _readerThread.Start();
    }

    public bool TryDequeue(out IncomingMessage? message) =>
        _incoming.TryDequeue(out message);

    public void Send(OutgoingMessage message)
    {
        try
        {
            WriteMessage(_output, message, _writeLock);
        }
        catch
        {
            // Ignore write errors if Chrome already closed the pipe.
        }
    }

    private void ReadLoop()
    {
        try
        {
            while (true)
            {
                byte[]? frame = ReadFrame(_input);
                if (frame is null)
                    break;

                if (Protocol.TryParseIncoming(frame, out var msg) && msg is not null)
                {
                    _incoming.Enqueue(msg);
                    if (_targetHwnd != IntPtr.Zero)
                        PostMessageW(_targetHwnd, WM_APP_MESSAGE, IntPtr.Zero, IntPtr.Zero);
                }
            }
        }
        catch
        {
            // Pipe closed or malformed frame size; trigger clean shutdown.
        }
        finally
        {
            if (_targetHwnd != IntPtr.Zero)
                PostMessageW(_targetHwnd, WM_APP_EOF, IntPtr.Zero, IntPtr.Zero);
        }
    }

    public static byte[]? ReadFrame(Stream input)
    {
        Span<byte> lenBuf = stackalloc byte[4];
        int headRead = ReadExact(input, lenBuf);
        if (headRead == 0)
            return null;
        if (headRead < 4)
            throw new InvalidDataException("Truncated 4-byte Native Messaging length prefix.");

        uint length = BinaryPrimitives.ReadUInt32LittleEndian(lenBuf);
        if (length == 0 || length > MaxFrameBytes)
            throw new InvalidDataException($"Invalid Native Messaging frame length: {length}.");

        byte[] payload = new byte[length];
        int bodyRead = ReadExact(input, payload);
        if (bodyRead < (int)length)
            throw new InvalidDataException("Truncated Native Messaging frame body.");

        return payload;
    }

    public static void WriteFrame(Stream output, ReadOnlySpan<byte> utf8Payload, object? syncRoot = null)
    {
        if (utf8Payload.IsEmpty || utf8Payload.Length > MaxFrameBytes)
            throw new InvalidDataException($"Invalid outgoing frame length: {utf8Payload.Length}.");

        byte[] lenBytes = new byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(lenBytes, (uint)utf8Payload.Length);

        if (syncRoot is not null)
        {
            lock (syncRoot)
            {
                output.Write(lenBytes, 0, 4);
                output.Write(utf8Payload);
                output.Flush();
            }
        }
        else
        {
            output.Write(lenBytes, 0, 4);
            output.Write(utf8Payload);
            output.Flush();
        }
    }

    public static void WriteMessage(Stream output, OutgoingMessage message, object? syncRoot = null)
    {
        byte[] payload = Protocol.SerializeOutgoing(message);
        WriteFrame(output, payload, syncRoot);
    }

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
