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

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(nint hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnregisterHotKey(nint hWnd, int id);

    private readonly nint _hwnd;
    private readonly HashSet<int> _registeredIds = new();
    private HotkeyConfig? _currentConfig;

    public Hotkeys(nint hwnd)
    {
        _hwnd = hwnd;
    }

    public string[] Apply(HotkeyConfig config)
    {
        if (_currentConfig is not null && _currentConfig == config && _registeredIds.Count == 3)
            return [];

        UnregisterAll();
        _currentConfig = config;

        var errors = new List<string>();
        TryRegisterOne(ID_CLICK_THROUGH, config.ClickThrough, errors);
        TryRegisterOne(ID_DODGE, config.Dodge, errors);
        TryRegisterOne(ID_MUTE, config.Mute, errors);
        return errors.ToArray();
    }

    private void TryRegisterOne(int id, string spec, List<string> errors)
    {
        if (string.IsNullOrWhiteSpace(spec))
            return;

        if (!TryParseHotkey(spec, out uint mods, out uint vk))
        {
            errors.Add(spec);
            return;
        }

        if (_hwnd != IntPtr.Zero && RegisterHotKey(_hwnd, id, mods | MOD_NOREPEAT, vk))
        {
            _registeredIds.Add(id);
        }
        else
        {
            errors.Add(spec);
        }
    }

    public void UnregisterAll()
    {
        if (_hwnd != IntPtr.Zero)
        {
            foreach (int id in _registeredIds)
                UnregisterHotKey(_hwnd, id);
        }
        _registeredIds.Clear();
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
