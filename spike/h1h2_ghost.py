"""H1: layered alpha renders correctly on Chrome PiP windows. H2: WS_EX_TRANSPARENT passes clicks through.
Places a magenta Tk window behind the PiP, measures composited pixels, injects one click."""
import ctypes
import json
import os
import statistics
import sys
import time
import tkinter as tk

from PIL import ImageGrab

from common import (GWL_EXSTYLE, TEST_URL, WS_EX_LAYERED, WS_EX_TRANSPARENT, Chrome, bring_topmost,
                    chrome_windows, clear_ghost, set_ghost)
import win32api
import win32con
import win32gui

OUT = os.path.join(os.path.dirname(__file__), "out")
os.makedirs(OUT, exist_ok=True)
kind = sys.argv[1] if len(sys.argv) > 1 else "native"

ch = Chrome(TEST_URL)
ch.wait_for("typeof openDocPip === 'function' && document.getElementById('v').currentTime > 0.5")
before = {w["hwnd"] for w in chrome_windows()}
print("open:", ch.eval("openNativePip()" if kind == "native" else "openDocPip('t')", gesture=True))
pip = None
for _ in range(30):
    time.sleep(0.2)
    pip = next((w for w in chrome_windows() if w["hwnd"] not in before and w["topmost"] and w["proc"] == "chrome.exe"), None)
    if pip:
        break
if not pip:
    print("PiP window not found. chrome windows:", json.dumps(chrome_windows()))
    sys.exit(1)
hwnd = pip["hwnd"]
L, T, R, B = pip["rect"]
print("pip", pip["title"], pip["rect"])

root = tk.Tk()
root.overrideredirect(True)
root.configure(bg="#ff00ff")
root.geometry(f"{R - L + 200}x{B - T + 200}+{L - 100}+{T - 100}")
root.attributes("-topmost", True)
clicks = []
root.bind("<Button-1>", lambda e: clicks.append((e.x_root, e.y_root)))


def pump(sec):
    end = time.time() + sec
    while time.time() < end:
        root.update()
        time.sleep(0.01)


pump(0.5)
bring_topmost(hwnd)
pump(0.5)

cx, cy = (L + R) // 2, (T + B) // 2 + 20
probe = (cx - 50, cy - 30, cx + 50, cy + 30)


def mean_rgb():
    im = ImageGrab.grab(probe, all_screens=True).convert("RGB")
    px = list(im.getdata())
    return tuple(round(statistics.mean(p[i] for p in px)) for i in range(3))


def snap(name):
    ImageGrab.grab((L - 100, T - 100, R + 100, B + 100), all_screens=True).save(os.path.join(OUT, f"{kind}_{name}.png"))


results = {}
results["baseline"] = mean_rgb(); snap("baseline")

set_ghost(hwnd, alpha=128); pump(0.5)
samples = []
for _ in range(30):
    samples.append(mean_rgb()); pump(0.1)
results["alpha50_first"] = samples[0]
results["alpha50_min_luma"] = min(sum(s) for s in samples)
results["alpha50_max_luma"] = max(sum(s) for s in samples)
snap("alpha50")

set_ghost(hwnd, alpha=26); pump(0.5)
results["alpha10"] = mean_rgb(); snap("alpha10")

win32gui.SetWindowPos(hwnd, 0, L - 300, T - 200, 0, 0,
                      win32con.SWP_NOSIZE | win32con.SWP_NOACTIVATE | win32con.SWP_NOZORDER)
pump(1.5)
ex = win32gui.GetWindowLong(hwnd, GWL_EXSTYLE)
results["layered_kept_after_move"] = bool(ex & WS_EX_LAYERED)
win32gui.SetWindowPos(hwnd, 0, L, T, 0, 0, win32con.SWP_NOSIZE | win32con.SWP_NOACTIVATE | win32con.SWP_NOZORDER)
pump(1)

saved = win32api.GetCursorPos()


def click():
    clicks.clear()
    win32api.SetCursorPos((cx, cy))
    pump(0.15)
    win32api.mouse_event(win32con.MOUSEEVENTF_LEFTDOWN, 0, 0)
    win32api.mouse_event(win32con.MOUSEEVENTF_LEFTUP, 0, 0)
    pump(0.4)
    return len(clicks)


set_ghost(hwnd, alpha=180, click_through=False); pump(0.3)
results["click_reached_bg_without_transparent"] = click()
set_ghost(hwnd, alpha=180, click_through=True); pump(0.3)
results["click_reached_bg_with_transparent"] = click()
results["foreground_is_pip"] = win32gui.GetForegroundWindow() == hwnd
win32api.SetCursorPos(saved)

clear_ghost(hwnd); pump(0.5)
results["after_clear"] = mean_rgb()
results["ex_after_clear"] = hex(win32gui.GetWindowLong(hwnd, GWL_EXSTYLE))
print(json.dumps(results, indent=1))
root.destroy()
ch.close()
