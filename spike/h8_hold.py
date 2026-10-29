"""H8: GetAsyncKeyState is blind while an elevated window has focus (H4). Which passive alternative still sees
Ctrl/Alt down+up from a NON-elevated engine? Raw input (RIDEV_INPUTSINK), WH_KEYBOARD_LL, RegisterHotKey(Ctrl, VK_MENU)."""
import ctypes
import ctypes.wintypes as wt
import json
import os
import subprocess
import sys
import tempfile
import time

import win32api
import win32con
import win32gui

u32 = ctypes.windll.user32
HERE = os.path.dirname(os.path.abspath(__file__))
MOD_ALT, MOD_CONTROL, MOD_NOREPEAT = 0x1, 0x2, 0x4000
WM_INPUT = 0x00FF
RIDEV_INPUTSINK = 0x100
RID_INPUT = 0x10000003
RI_KEY_BREAK = 1
WH_KEYBOARD_LL = 13
MODS = {0x11, 0x12, 0xA2, 0xA3, 0xA4, 0xA5}


class RAWINPUTDEVICE(ctypes.Structure):
    _fields_ = [("usUsagePage", wt.USHORT), ("usUsage", wt.USHORT), ("dwFlags", wt.DWORD), ("hwndTarget", wt.HWND)]


class RAWINPUTHEADER(ctypes.Structure):
    _fields_ = [("dwType", wt.DWORD), ("dwSize", wt.DWORD), ("hDevice", wt.HANDLE), ("wParam", wt.WPARAM)]


class RAWKEYBOARD(ctypes.Structure):
    _fields_ = [("MakeCode", wt.USHORT), ("Flags", wt.USHORT), ("Reserved", wt.USHORT), ("VKey", wt.USHORT),
                ("Message", wt.UINT), ("ExtraInformation", wt.ULONG)]


class RAWINPUT(ctypes.Structure):
    _fields_ = [("header", RAWINPUTHEADER), ("keyboard", RAWKEYBOARD)]


class KBDLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [("vkCode", wt.DWORD), ("scanCode", wt.DWORD), ("flags", wt.DWORD), ("time", wt.DWORD),
                ("dwExtraInfo", ctypes.c_void_p)]


HOOKPROC = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, ctypes.c_int, wt.WPARAM, wt.LPARAM)
u32.CallNextHookEx.argtypes = [ctypes.c_void_p, ctypes.c_int, wt.WPARAM, wt.LPARAM]
u32.CallNextHookEx.restype = ctypes.c_ssize_t
u32.SetWindowsHookExW.argtypes = [ctypes.c_int, HOOKPROC, wt.HINSTANCE, wt.DWORD]
u32.SetWindowsHookExW.restype = ctypes.c_void_p
u32.GetRawInputData.argtypes = [ctypes.c_void_p, wt.UINT, ctypes.c_void_p, ctypes.POINTER(wt.UINT), wt.UINT]
ctypes.windll.kernel32.GetModuleHandleW.restype = wt.HMODULE
ctypes.windll.kernel32.GetModuleHandleW.argtypes = [wt.LPCWSTR]


def run_case(elevated):
    ev = {"raw": [], "llhook": [], "hotkey": [], "async": 0}

    def wndproc(hwnd, msg, wp, lp):
        if msg == WM_INPUT:
            ri = RAWINPUT()
            size = wt.UINT(ctypes.sizeof(ri))
            if u32.GetRawInputData(ctypes.c_void_p(lp), RID_INPUT, ctypes.byref(ri), ctypes.byref(size),
                                   ctypes.sizeof(RAWINPUTHEADER)) > 0 and ri.header.dwType == 1:
                if ri.keyboard.VKey in MODS:
                    ev["raw"].append(("up" if ri.keyboard.Flags & RI_KEY_BREAK else "down", ri.keyboard.VKey))
        elif msg == win32con.WM_HOTKEY:
            ev["hotkey"].append(wp)
        return win32gui.DefWindowProc(hwnd, msg, wp, lp)

    wc = win32gui.WNDCLASS()
    wc.lpszClassName = f"GhostPiPH8_{int(elevated)}"
    wc.lpfnWndProc = wndproc
    win32gui.RegisterClass(wc)
    hwnd = win32gui.CreateWindow(wc.lpszClassName, "h8", win32con.WS_POPUP, 0, 0, 1, 1, 0, 0, 0, None)

    rid = RAWINPUTDEVICE(1, 6, RIDEV_INPUTSINK, hwnd)
    raw_ok = bool(u32.RegisterRawInputDevices(ctypes.byref(rid), 1, ctypes.sizeof(rid)))

    @HOOKPROC
    def ll(n, wp, lp):
        if n == 0:
            k = ctypes.cast(lp, ctypes.POINTER(KBDLLHOOKSTRUCT)).contents
            if k.vkCode in MODS:
                ev["llhook"].append(("up" if wp in (win32con.WM_KEYUP, win32con.WM_SYSKEYUP) else "down", k.vkCode))
        return u32.CallNextHookEx(None, n, wp, lp)

    hook = u32.SetWindowsHookExW(WH_KEYBOARD_LL, ll, ctypes.windll.kernel32.GetModuleHandleW(None), 0)
    hook_err = ctypes.windll.kernel32.GetLastError() if not hook else 0
    hk_ok = bool(u32.RegisterHotKey(hwnd, 7, MOD_CONTROL | MOD_NOREPEAT, win32con.VK_MENU))

    log = os.path.join(tempfile.gettempdir(), f"ghostpip_h8_{int(elevated)}.json")
    if os.path.exists(log):
        os.remove(log)
    args = f'"{os.path.join(HERE, "h4_game.py")}" "{log}"'
    if elevated:
        if ctypes.windll.shell32.ShellExecuteW(None, "runas", sys.executable, args, HERE, 1) <= 32:
            return {"error": "UAC declined"}
    else:
        subprocess.Popen([sys.executable, os.path.join(HERE, "h4_game.py"), log])

    end = time.time() + 40
    while not os.path.exists(log) and time.time() < end:
        win32gui.PumpWaitingMessages()
        if (u32.GetAsyncKeyState(0x11) & 0x8000) and (u32.GetAsyncKeyState(0x12) & 0x8000):
            ev["async"] += 5
        time.sleep(0.005)
    for _ in range(40):
        win32gui.PumpWaitingMessages(); time.sleep(0.005)

    u32.UnhookWindowsHookEx(ctypes.c_void_p(hook))
    u32.UnregisterHotKey(hwnd, 7)
    win32gui.DestroyWindow(hwnd)
    time.sleep(0.2)
    game = json.load(open(log)) if os.path.exists(log) else {"error": "game log missing"}
    summarize = lambda xs: {"down": sum(1 for d, _ in xs if d == "down"), "up": sum(1 for d, _ in xs if d == "up")}
    return dict(game=game, raw_registered=raw_ok, raw=summarize(ev["raw"]), llhook_installed=bool(hook), llhook_err=hook_err,
                llhook=summarize(ev["llhook"]), hotkey_ctrl_alt_registered=hk_ok, hotkey_ctrl_alt_fired=len(ev["hotkey"]),
                getasynckeystate_ms=ev["async"])


if __name__ == "__main__":
    if ctypes.windll.shell32.IsUserAnAdmin():
        sys.exit("H8 must run from a NON-admin PowerShell.")
    print("control (normal game):", json.dumps(run_case(False)))
    print("real (admin game, accept UAC):", json.dumps(run_case(True)))
