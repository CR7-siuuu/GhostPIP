"""H4: Does a non-elevated engine receive RegisterHotKey and see GetAsyncKeyState while an ELEVATED window has focus?
Runs a control (normal game) then the real case (admin game, UAC prompt)."""
import ctypes
import ctypes.wintypes as wt
import json
import os
import subprocess
import sys
import tempfile
import threading
import time

import win32con

u32 = ctypes.windll.user32
HERE = os.path.dirname(os.path.abspath(__file__))
MOD_ALT, MOD_NOREPEAT = 0x1, 0x4000


def run_case(elevated):
    log = os.path.join(tempfile.gettempdir(), f"ghostpip_h4_{int(elevated)}.json")
    if os.path.exists(log):
        os.remove(log)
    hotkeys, ready = [], threading.Event()
    tid = []

    def hotkey_thread():
        tid.append(ctypes.windll.kernel32.GetCurrentThreadId())
        ok = u32.RegisterHotKey(None, 1, MOD_ALT | MOD_NOREPEAT, ord("G"))
        hotkeys.append(("registered", bool(ok)))
        ready.set()
        msg = wt.MSG()
        while u32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            if msg.message == win32con.WM_HOTKEY:
                hotkeys.append(("WM_HOTKEY", time.time()))
        u32.UnregisterHotKey(None, 1)

    th = threading.Thread(target=hotkey_thread, daemon=True)
    th.start()
    ready.wait()

    args = f'"{os.path.join(HERE, "h4_game.py")}" "{log}"'
    if elevated:
        r = ctypes.windll.shell32.ShellExecuteW(None, "runas", sys.executable, args, HERE, 1)
        if r <= 32:
            return {"error": f"UAC declined or failed ({r})"}
    else:
        subprocess.Popen([sys.executable, os.path.join(HERE, "h4_game.py"), log])

    both_down = []
    end = time.time() + 30
    while not os.path.exists(log) and time.time() < end:
        if (u32.GetAsyncKeyState(win32con.VK_CONTROL) & 0x8000) and (u32.GetAsyncKeyState(win32con.VK_MENU) & 0x8000):
            both_down.append(time.time())
        time.sleep(0.01)
    time.sleep(0.3)
    u32.PostThreadMessageW(tid[0], win32con.WM_QUIT, 0, 0)
    th.join(2)
    game = json.load(open(log)) if os.path.exists(log) else {"error": "game log missing"}
    return dict(game=game, hotkey_registered=hotkeys[0][1],
                wm_hotkey_received=sum(1 for h in hotkeys if h[0] == "WM_HOTKEY"),
                ctrl_alt_seen_by_getasynckeystate_ms=len(both_down) * 10)


if __name__ == "__main__":
    if ctypes.windll.shell32.IsUserAnAdmin():
        sys.exit("H4 must run from a NON-admin PowerShell (the engine side must be non-elevated).")
    print("engine is admin:", False)
    print("control (normal game):", json.dumps(run_case(False)))
    print("real (admin game, accept UAC):", json.dumps(run_case(True)))
