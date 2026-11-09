using System.Runtime.InteropServices;
using System.Text;

namespace GhostPiP.Engine;

public sealed class Hotkeys : IDisposable
{
    public const uint MOD_ALT = 0x0001;
    public const uint MOD_CONTROL = 0x0002;
    public const uint MOD_SHIFT = 0x0004;
    public const uint MOD_WIN = 0x0008;
    public const uint MOD_NOREPEAT = 0x4000;

    public const int ID_CLICK_THROUGH = 1;
    public const int ID_DODGE = 2;
    public const int ID_MUTE = 3;
    public const int ID_PEEK = 4;
    public const int ID_PLAY_PAUSE = 5;
    public const int ID_SEEK_BACK = 6;
    public const int ID_SEEK_FORWARD = 7;

    /// <summary>Mirror of shared/hotkey-vectors.json "reserved"; the self-test fails if they drift.</summary>
    public static readonly HashSet<string> Reserved = new(StringComparer.Ordinal)
    {
        "Ctrl+A", "Ctrl+C", "Ctrl+V", "Ctrl+X", "Ctrl+Z", "Ctrl+Y", "Ctrl+S", "Ctrl+F", "Ctrl+P",
        "Ctrl+W", "Ctrl+T", "Ctrl+N", "Ctrl+TAB", "Ctrl+Shift+TAB", "Ctrl+ESC", "Ctrl+ESCAPE",
        "Ctrl+Shift+ESC", "Ctrl+Shift+ESCAPE", "Alt+TAB", "Alt+Shift+TAB", "Alt+F4", "Alt+ESC",
        "Alt+ESCAPE", "Ctrl+Alt+DELETE"
    };

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(nint hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnregisterHotKey(nint hWnd, int id);

    private readonly nint _hwnd;
    private readonly HashSet<int> _registered = new();
    private readonly Dictionary<int, string?> _attempted = new();

    public Hotkeys(nint hwnd)
    {
        _hwnd = hwnd;
    }

    /// <summary>
    /// Brings registrations in line with the wanted set. Peek is registered only while peek mode is
    /// on, media keys only while a tracked PiP is playing. An id whose spec is unchanged since the
    /// last attempt is left alone, so a failing combo is not retried every tick; call
    /// <see cref="UnregisterAll"/> first to force a retry after the user edits hotkeys.
    /// </summary>
    public string[] Apply(HotkeyConfig config, bool peek, bool media)
    {
        var errors = new List<string>();
        Sync(ID_CLICK_THROUGH, config.ClickThrough, noRepeat: true, errors);
        Sync(ID_DODGE, config.Dodge, noRepeat: true, errors);
        Sync(ID_MUTE, config.Mute, noRepeat: true, errors);
        Sync(ID_PEEK, peek ? config.Peek : null, noRepeat: true, errors);
        Sync(ID_PLAY_PAUSE, media ? config.PlayPause : null, noRepeat: true, errors);
        Sync(ID_SEEK_BACK, media ? config.SeekBack : null, noRepeat: false, errors);
        Sync(ID_SEEK_FORWARD, media ? config.SeekForward : null, noRepeat: false, errors);
        return errors.ToArray();
    }

    public bool IsRegistered(int id) => _registered.Contains(id);

    private void Sync(int id, string? spec, bool noRepeat, List<string> errors)
    {
        string? wanted = string.IsNullOrWhiteSpace(spec) ? null : spec;
        if (_attempted.TryGetValue(id, out string? prev) && string.Equals(prev, wanted, StringComparison.Ordinal))
            return;

        _attempted[id] = wanted;
        if (_registered.Remove(id) && _hwnd != IntPtr.Zero)
            UnregisterHotKey(_hwnd, id);

        if (wanted is null)
            return;

        if (!TryParseHotkey(wanted, out uint mods, out uint vk))
        {
            errors.Add(wanted);
            return;
        }

        uint flags = noRepeat ? (mods | MOD_NOREPEAT) : mods;
        if (_hwnd != IntPtr.Zero && RegisterHotKey(_hwnd, id, flags, vk))
            _registered.Add(id);
        else
            errors.Add(wanted);
    }

    public void UnregisterAll()
    {
        if (_hwnd != IntPtr.Zero)
        {
            foreach (int id in _registered)
                UnregisterHotKey(_hwnd, id);
        }
        _registered.Clear();
        _attempted.Clear();
    }

    public void Dispose() => UnregisterAll();

    public static bool TryParseHotkey(string? spec, out uint modifiers, out uint vk) =>
        TryParseHotkey(spec, out modifiers, out vk, out _);

    /// <summary>
    /// The shared hotkey rule (shared/hotkey-vectors.json): one valid key token plus modifiers, the key
    /// is F1-F12 or the modifiers include Ctrl/Alt/Win, and the normalized combo is not reserved.
    /// </summary>
    public static bool TryParseHotkey(string? spec, out uint modifiers, out uint vk, out string normalized)
    {
        modifiers = 0;
        vk = 0;
        normalized = string.Empty;
        if (string.IsNullOrWhiteSpace(spec))
            return false;

        string? keyToken = null;
        foreach (string part in spec.Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            uint mod = ModifierOf(part);
            if (mod != 0)
            {
                modifiers |= mod;
                continue;
            }
            if (keyToken is not null || !TryParseKeyToken(part, out vk))
                return false;
            keyToken = part.ToUpperInvariant();
        }

        if (keyToken is null)
            return false;

        bool isFunctionKey = vk is >= 0x70 and <= 0x7B;
        if (!isFunctionKey && (modifiers & (MOD_CONTROL | MOD_ALT | MOD_WIN)) == 0)
            return false;

        var sb = new StringBuilder();
        if ((modifiers & MOD_CONTROL) != 0) sb.Append("Ctrl+");
        if ((modifiers & MOD_ALT) != 0) sb.Append("Alt+");
        if ((modifiers & MOD_SHIFT) != 0) sb.Append("Shift+");
        if ((modifiers & MOD_WIN) != 0) sb.Append("Win+");
        sb.Append(keyToken);
        normalized = sb.ToString();
        return !Reserved.Contains(normalized);
    }

    private static uint ModifierOf(string part)
    {
        if (string.Equals(part, "Alt", StringComparison.OrdinalIgnoreCase))
            return MOD_ALT;
        if (string.Equals(part, "Ctrl", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(part, "Control", StringComparison.OrdinalIgnoreCase))
            return MOD_CONTROL;
        if (string.Equals(part, "Shift", StringComparison.OrdinalIgnoreCase))
            return MOD_SHIFT;
        if (string.Equals(part, "Win", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(part, "Meta", StringComparison.OrdinalIgnoreCase))
            return MOD_WIN;
        return 0;
    }

    private static bool TryParseKeyToken(string token, out uint vk)
    {
        vk = 0;
        if (token.Length == 1)
        {
            char c = char.ToUpperInvariant(token[0]);
            if (c is >= 'A' and <= 'Z')
            {
                vk = c;
                return true;
            }
            if (c is >= '0' and <= '9')
            {
                vk = c;
                return true;
            }
            vk = token[0] switch
            {
                '`' => 0xC0,
                '-' => 0xBD,
                '=' => 0xBB,
                '[' => 0xDB,
                ']' => 0xDD,
                '\\' => 0xDC,
                ';' => 0xBA,
                '\'' => 0xDE,
                ',' => 0xBC,
                '.' => 0xBE,
                '/' => 0xBF,
                _ => 0
            };
            return vk != 0;
        }

        if ((token[0] == 'F' || token[0] == 'f') &&
            int.TryParse(token.AsSpan(1), out int fnNum) &&
            fnNum is >= 1 and <= 12)
        {
            vk = (uint)(0x70 + fnNum - 1);
            return true;
        }

        vk = token.ToUpperInvariant() switch
        {
            "SPACE" => 0x20,
            "TAB" => 0x09,
            "ENTER" => 0x0D,
            "BACKSPACE" => 0x08,
            "BACKQUOTE" => 0xC0,
            "ESC" or "ESCAPE" => 0x1B,
            "LEFT" => 0x25,
            "UP" => 0x26,
            "RIGHT" => 0x27,
            "DOWN" => 0x28,
            "HOME" => 0x24,
            "END" => 0x23,
            "PAGEUP" => 0x21,
            "PAGEDOWN" => 0x22,
            "INSERT" => 0x2D,
            "DELETE" => 0x2E,
            _ => 0
        };
        return vk != 0;
    }
}
