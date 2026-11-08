using System.Runtime.InteropServices;

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

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(nint hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnregisterHotKey(nint hWnd, int id);

    private readonly nint _hwnd;
    private readonly HashSet<int> _registeredIds = new();
    private HotkeyConfig? _currentConfig;
    private bool _mediaActive;
    private bool _lastApplyHadErrors;
    private string? _mediaPlayPause;
    private string? _mediaSeekBack;
    private string? _mediaSeekForward;

    public Hotkeys(nint hwnd)
    {
        _hwnd = hwnd;
    }

    public string[] Apply(HotkeyConfig config, bool registerMedia = false)
    {
        if (_currentConfig is not null &&
            _currentConfig == config &&
            _mediaActive == registerMedia &&
            !_lastApplyHadErrors)
        {
            return [];
        }

        UnregisterAll();
        _currentConfig = config;
        _mediaActive = registerMedia;
        _mediaPlayPause = registerMedia ? config.PlayPause : null;
        _mediaSeekBack = registerMedia ? config.SeekBack : null;
        _mediaSeekForward = registerMedia ? config.SeekForward : null;

        var errors = new List<string>();
        TryRegisterOne(ID_CLICK_THROUGH, config.ClickThrough, noRepeat: true, errors);
        TryRegisterOne(ID_DODGE, config.Dodge, noRepeat: true, errors);
        TryRegisterOne(ID_MUTE, config.Mute, noRepeat: true, errors);
        TryRegisterOne(ID_PEEK, config.Peek, noRepeat: true, errors);

        if (registerMedia)
        {
            TryRegisterOne(ID_PLAY_PAUSE, config.PlayPause, noRepeat: true, errors);
            TryRegisterOne(ID_SEEK_BACK, config.SeekBack, noRepeat: false, errors);
            TryRegisterOne(ID_SEEK_FORWARD, config.SeekForward, noRepeat: false, errors);
        }

        _lastApplyHadErrors = errors.Count > 0;
        return errors.ToArray();
    }

    public void SetMediaActive(HotkeyConfig config, bool active)
    {
        if (!active)
        {
            UnregisterOne(ID_PLAY_PAUSE);
            UnregisterOne(ID_SEEK_BACK);
            UnregisterOne(ID_SEEK_FORWARD);
            _mediaActive = false;
            _mediaPlayPause = null;
            _mediaSeekBack = null;
            _mediaSeekForward = null;
            return;
        }

        if (_mediaActive &&
            string.Equals(_mediaPlayPause, config.PlayPause, StringComparison.Ordinal) &&
            string.Equals(_mediaSeekBack, config.SeekBack, StringComparison.Ordinal) &&
            string.Equals(_mediaSeekForward, config.SeekForward, StringComparison.Ordinal))
        {
            return;
        }

        UnregisterOne(ID_PLAY_PAUSE);
        UnregisterOne(ID_SEEK_BACK);
        UnregisterOne(ID_SEEK_FORWARD);

        TryRegisterOne(ID_PLAY_PAUSE, config.PlayPause, noRepeat: true, errors: null);
        TryRegisterOne(ID_SEEK_BACK, config.SeekBack, noRepeat: false, errors: null);
        TryRegisterOne(ID_SEEK_FORWARD, config.SeekForward, noRepeat: false, errors: null);

        _mediaActive = true;
        _mediaPlayPause = config.PlayPause;
        _mediaSeekBack = config.SeekBack;
        _mediaSeekForward = config.SeekForward;
    }

    private void TryRegisterOne(int id, string spec, bool noRepeat, List<string>? errors)
    {
        if (string.IsNullOrWhiteSpace(spec))
            return;

        if (!TryParseHotkey(spec, out uint mods, out uint vk))
        {
            errors?.Add(spec);
            return;
        }

        uint flags = noRepeat ? (mods | MOD_NOREPEAT) : mods;
        if (_hwnd != IntPtr.Zero && RegisterHotKey(_hwnd, id, flags, vk))
        {
            _registeredIds.Add(id);
        }
        else
        {
            errors?.Add(spec);
        }
    }

    private void UnregisterOne(int id)
    {
        if (!_registeredIds.Remove(id))
            return;

        if (_hwnd != IntPtr.Zero)
            UnregisterHotKey(_hwnd, id);
    }

    public void UnregisterAll()
    {
        if (_hwnd != IntPtr.Zero)
        {
            foreach (int id in _registeredIds)
                UnregisterHotKey(_hwnd, id);
        }
        _registeredIds.Clear();
        _mediaActive = false;
        _mediaPlayPause = null;
        _mediaSeekBack = null;
        _mediaSeekForward = null;
    }

    public void Dispose() => UnregisterAll();

    public static bool TryParseHotkey(string? spec, out uint modifiers, out uint vk)
    {
        modifiers = 0;
        vk = 0;
        if (string.IsNullOrWhiteSpace(spec))
            return false;

        string[] parts = spec.Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Length < 1)
            return false;

        for (int i = 0; i < parts.Length; i++)
        {
            string part = parts[i];
            if (string.Equals(part, "Alt", StringComparison.OrdinalIgnoreCase))
            {
                modifiers |= MOD_ALT;
            }
            else if (string.Equals(part, "Ctrl", StringComparison.OrdinalIgnoreCase) ||
                     string.Equals(part, "Control", StringComparison.OrdinalIgnoreCase))
            {
                modifiers |= MOD_CONTROL;
            }
            else if (string.Equals(part, "Shift", StringComparison.OrdinalIgnoreCase))
            {
                modifiers |= MOD_SHIFT;
            }
            else if (string.Equals(part, "Win", StringComparison.OrdinalIgnoreCase) ||
                     string.Equals(part, "Meta", StringComparison.OrdinalIgnoreCase))
            {
                modifiers |= MOD_WIN;
            }
            else
            {
                if (vk != 0)
                    return false;
                if (!TryParseKeyToken(part, out vk))
                    return false;
            }
        }

        bool isFunctionKey = vk is >= 0x70 and <= 0x7B;
        return vk != 0 && (modifiers != 0 || isFunctionKey);
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
