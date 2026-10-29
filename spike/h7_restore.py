"""H7: How do we restore a Chrome PiP after ghosting? Plain removal of WS_EX_LAYERED left the PiP invisible (H1 run).
Tries restore variants and measures whether green PiP pixels come back."""
import json
import os
import statistics
import sys
import time
import tkinter as tk

from PIL import ImageGrab

from common import GWL_EXSTYLE, TEST_URL, WS_EX_LAYERED, WS_EX_TRANSPARENT, Chrome, bring_topmost, chrome_windows, set_ghost
import win32con
import win32gui

kind = sys.argv[1] if len(sys.argv) > 1 else "native"
ch = Chrome(TEST_URL)
ch.wait_for("typeof openDocPip === 'function' && document.getElementById('v').currentTime > 0.5")
before = {w["hwnd"] for w in chrome_windows()}
ch.eval("openNativePip()" if kind == "native" else "openDocPip('t')", gesture=True)
pip = None
for _ in range(30):
    time.sleep(0.2)
    pip = next((w for w in chrome_windows() if w["hwnd"] not in before and w["topmost"] and w["proc"] == "chrome.exe"), None)
    if pip:
        break
hwnd = pip["hwnd"]
L, T, R, B = pip["rect"]

root = tk.Tk()
root.overrideredirect(True)
root.configure(bg="#ff00ff")
root.geometry(f"{R - L + 200}x{B - T + 200}+{L - 100}+{T - 100}")
root.attributes("-topmost", True)


def pump(sec):
    end = time.time() + sec
    while time.time() < end:
        root.update()
        time.sleep(0.01)


pump(0.5); bring_topmost(hwnd); pump(0.5)
cx, cy = (L + R) // 2, (T + B) // 2 + 20


def mean_rgb():
    im = ImageGrab.grab((cx - 50, cy - 30, cx + 50, cy + 30), all_screens=True).convert("RGB")
    px = list(im.getdata())
    return [round(statistics.mean(p[i] for p in px)) for i in range(3)]


def remove_layered():
    ex = win32gui.GetWindowLong(hwnd, GWL_EXSTYLE)
    win32gui.SetWindowLong(hwnd, GWL_EXSTYLE, ex & ~(WS_EX_LAYERED | WS_EX_TRANSPARENT))


FLAGS = win32con.SWP_NOMOVE | win32con.SWP_NOSIZE | win32con.SWP_NOZORDER | win32con.SWP_NOACTIVATE


def v_keep_layered_alpha255():
    set_ghost(hwnd, alpha=255, click_through=False)


def v_remove_only():
    remove_layered()


def v_remove_redraw():
    remove_layered()
    win32gui.RedrawWindow(hwnd, None, None, win32con.RDW_ERASE | win32con.RDW_INVALIDATE | win32con.RDW_FRAME | win32con.RDW_ALLCHILDREN)


def v_remove_framechanged():
    remove_layered()
    win32gui.SetWindowPos(hwnd, 0, 0, 0, 0, 0, FLAGS | win32con.SWP_FRAMECHANGED)


def v_remove_resize_nudge():
    remove_layered()
    l, t, r, b = win32gui.GetWindowRect(hwnd)
    f = win32con.SWP_NOMOVE | win32con.SWP_NOZORDER | win32con.SWP_NOACTIVATE
    win32gui.SetWindowPos(hwnd, 0, 0, 0, r - l + 1, b - t, f)
    pump(0.15)
    win32gui.SetWindowPos(hwnd, 0, 0, 0, r - l, b - t, f)


def v_remove_hide_show():
    remove_layered()
    win32gui.ShowWindow(hwnd, win32con.SW_HIDE)
    pump(0.1)
    win32gui.ShowWindow(hwnd, win32con.SW_SHOWNA)


results = {"baseline": mean_rgb()}
for v in [v_keep_layered_alpha255, v_remove_redraw, v_remove_framechanged, v_remove_resize_nudge,
          v_remove_hide_show, v_remove_only]:
    set_ghost(hwnd, alpha=128, click_through=True); pump(0.6)
    ghosted = mean_rgb()
    v(); bring_topmost(hwnd)
    pump(0.7); after = mean_rgb()
    pump(2.0); later = mean_rgb()
    results[v.__name__[2:]] = dict(ghosted=ghosted, after_0_7s=after, after_2_7s=later,
                                   ex=hex(win32gui.GetWindowLong(hwnd, GWL_EXSTYLE)), visible=bool(win32gui.IsWindowVisible(hwnd)))
print(json.dumps(results))
root.destroy()
ch.close()
