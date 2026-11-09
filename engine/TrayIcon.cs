using System.Runtime.InteropServices;

namespace GhostPiP.Engine;

public enum TrayAction
{
    None = 0,
    EmergencyRelease = 1001,
    Exit = 1002
}

public sealed unsafe class TrayIcon : IDisposable
{
    public const uint WM_APP_TRAY = 0x8003;

    private const uint NIM_ADD = 0x00000000;
    private const uint NIM_MODIFY = 0x00000001;
    private const uint NIM_DELETE = 0x00000002;
    private const uint NIF_MESSAGE = 0x00000001;
    private const uint NIF_ICON = 0x00000002;
    private const uint NIF_TIP = 0x00000004;

    private const uint WM_RBUTTONUP = 0x0205;
    private const uint WM_CONTEXTMENU = 0x007B;

    private const uint MF_STRING = 0x00000000;
    private const uint MF_GRAYED = 0x00000001;
    private const uint MF_SEPARATOR = 0x00000800;
    private const uint TPM_RETURNCMD = 0x0100;
    private const uint TPM_NONOTIFY = 0x0080;
    private const uint TPM_RIGHTBUTTON = 0x0002;

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NOTIFYICONDATAW
    {
        public uint cbSize;
        public nint hWnd;
        public uint uID;
        public uint uFlags;
        public uint uCallbackMessage;
        public nint hIcon;
        public fixed char szTip[128];
        public uint dwState;
        public uint dwStateMask;
        public fixed char szInfo[256];
        public uint uTimeoutOrVersion;
        public fixed char szInfoTitle[64];
        public uint dwInfoFlags;
        public Guid guidItem;
        public nint hBalloonIcon;
    }

    [DllImport("shell32.dll", EntryPoint = "Shell_NotifyIconW", SetLastError = true)]
    private static extern bool Shell_NotifyIconW(uint dwMessage, ref NOTIFYICONDATAW lpData);

    [DllImport("user32.dll", EntryPoint = "LoadIconW", SetLastError = true)]
    private static extern nint LoadIconW(nint hInstance, nint lpIconName);

    [DllImport("user32.dll", EntryPoint = "LoadImageW", SetLastError = true)]
    private static extern nint LoadImageW(nint hInst, nint name, uint type, int cx, int cy, uint fuLoad);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int nIndex);

    private const uint IMAGE_ICON = 1;
    private const int SM_CXSMICON = 49;
    private const int SM_CYSMICON = 50;
    // Matches "1 ICON" in GhostPiP.Engine.rc.
    private const int APP_ICON_ID = 1;

    [DllImport("kernel32.dll", EntryPoint = "GetModuleHandleW", CharSet = CharSet.Unicode)]
    private static extern nint GetModuleHandleW(string? lpModuleName);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern nint CreatePopupMenu();

    [DllImport("user32.dll", EntryPoint = "AppendMenuW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool AppendMenuW(nint hMenu, uint uFlags, nuint uIDNewItem, string? lpNewItem);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern int TrackPopupMenu(nint hMenu, uint uFlags, int x, int y, int nReserved, nint hWnd, nint prcRect);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool DestroyMenu(nint hMenu);

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out POINT lpPoint);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(nint hWnd);

    private readonly nint _hwnd;
    private bool _added;
    private TrayStrings _strings = TrayStrings.English;

    public TrayIcon(nint hwnd)
    {
        _hwnd = hwnd;
        if (_hwnd == IntPtr.Zero)
            return;

        var nid = CreateData();
        _added = Shell_NotifyIconW(NIM_ADD, ref nid);
    }

    public void SetStrings(TrayStrings strings)
    {
        _strings = strings;
        if (!_added)
            return;
        var nid = CreateData();
        Shell_NotifyIconW(NIM_MODIFY, ref nid);
    }

    private NOTIFYICONDATAW CreateData()
    {
        nint hInst = GetModuleHandleW(null);
        nint hIcon = LoadImageW(hInst, APP_ICON_ID, IMAGE_ICON, GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON), 0);
        if (hIcon == IntPtr.Zero)
            hIcon = LoadIconW(IntPtr.Zero, (nint)32512);

        var nid = new NOTIFYICONDATAW
        {
            cbSize = (uint)sizeof(NOTIFYICONDATAW),
            hWnd = _hwnd,
            uID = 1,
            uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP,
            uCallbackMessage = WM_APP_TRAY,
            hIcon = hIcon
        };

        string tip = _strings.Tip.Length > 127 ? _strings.Tip[..127] : _strings.Tip;
        for (int i = 0; i < tip.Length; i++)
            nid.szTip[i] = tip[i];
        nid.szTip[tip.Length] = '\0';
        return nid;
    }

    public TrayAction HandleMessage(nint lParam, string clickThroughHotkey)
    {
        uint mouseMsg = (uint)((long)lParam & 0xFFFF);
        if (mouseMsg is not (WM_RBUTTONUP or WM_CONTEXTMENU))
            return TrayAction.None;

        nint hMenu = CreatePopupMenu();
        if (hMenu == IntPtr.Zero)
            return TrayAction.None;

        try
        {
            AppendMenuW(hMenu, MF_STRING | MF_GRAYED, 0, _strings.Active);
            AppendMenuW(hMenu, MF_SEPARATOR, 0, null);
            AppendMenuW(hMenu, MF_STRING, (nuint)TrayAction.EmergencyRelease, $"{_strings.Emergency} ({clickThroughHotkey})");
            AppendMenuW(hMenu, MF_STRING, (nuint)TrayAction.Exit, _strings.Exit);

            GetCursorPos(out var pt);
            SetForegroundWindow(_hwnd);
            int cmd = TrackPopupMenu(
                hMenu,
                TPM_RETURNCMD | TPM_NONOTIFY | TPM_RIGHTBUTTON,
                pt.X,
                pt.Y,
                0,
                _hwnd,
                IntPtr.Zero);

            return cmd switch
            {
                (int)TrayAction.EmergencyRelease => TrayAction.EmergencyRelease,
                (int)TrayAction.Exit => TrayAction.Exit,
                _ => TrayAction.None
            };
        }
        finally
        {
            DestroyMenu(hMenu);
        }
    }

    public void Dispose()
    {
        if (!_added || _hwnd == IntPtr.Zero)
            return;

        _added = false;
        var nid = new NOTIFYICONDATAW
        {
            cbSize = (uint)sizeof(NOTIFYICONDATAW),
            hWnd = _hwnd,
            uID = 1
        };
        Shell_NotifyIconW(NIM_DELETE, ref nid);
    }
}
