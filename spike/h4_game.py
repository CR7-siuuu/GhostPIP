"""H4 helper: a stand-in 'game' window. Takes foreground, then injects Alt+G and a 600ms Ctrl+Alt hold.
Launched by h4_hotkeys.py either normally or elevated."""
import ctypes
import json
import sys
import time
import tkinter as tk

import win32api
import win32con
import win32gui

log_path = sys.argv[1]
root = tk.Tk()
root.title("GhostPiP FakeGame")
root.geometry("500x200+200+200")
tk.Label(root, text="FakeGame - " + ("ADMIN" if ctypes.windll.shell32.IsUserAnAdmin() else "normal"),
         font=("Segoe UI", 20)).pack(expand=True)
root.attributes("-topmost", True)


def pump(sec):
    end = time.time() + sec
    while time.time() < end:
        root.update()
        time.sleep(0.01)


pump(0.5)
hwnd = int(root.wm_frame(), 16)
try:
    win32gui.SetForegroundWindow(hwnd)
except Exception:
    pass
pump(0.8)
fg = win32gui.GetForegroundWindow() == hwnd

k = lambda vk, up=False: win32api.keybd_event(vk, 0, win32con.KEYEVENTF_KEYUP if up else 0, 0)
t_hotkey = time.time()
k(win32con.VK_MENU); k(ord("G")); k(ord("G"), True); k(win32con.VK_MENU, True)
pump(0.5)
t_hold = time.time()
k(win32con.VK_CONTROL); k(win32con.VK_MENU)
pump(0.6)
k(win32con.VK_MENU, True); k(win32con.VK_CONTROL, True)
pump(0.3)

with open(log_path, "w") as f:
    json.dump(dict(admin=bool(ctypes.windll.shell32.IsUserAnAdmin()), game_was_foreground=fg,
                   t_hotkey=t_hotkey, t_hold=t_hold), f)
root.destroy()
