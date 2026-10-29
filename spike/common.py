"""Phase 0 throwaway spike helpers. Not production code."""
import ctypes
import ctypes.wintypes as wt
import json
import os
import subprocess
import tempfile
import threading
import time
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))

import win32con
import win32gui
import win32process
from websockets.sync.client import connect

HERE = os.path.dirname(os.path.abspath(__file__))
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
CDP_PORT = 9333
HTTP_PORT = 8765

GWL_EXSTYLE = -20
WS_EX_TOPMOST = 0x8
WS_EX_TRANSPARENT = 0x20
WS_EX_LAYERED = 0x80000
LWA_ALPHA = 0x2


def process_name(pid):
    h = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
    if not h:
        return ""
    buf = ctypes.create_unicode_buffer(1024)
    size = wt.DWORD(1024)
    ctypes.windll.kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size))
    ctypes.windll.kernel32.CloseHandle(h)
    return os.path.basename(buf.value).lower()


def chrome_windows(pid=None):
    out = []

    def cb(hwnd, _):
        if not win32gui.IsWindowVisible(hwnd):
            return True
        if win32gui.GetClassName(hwnd) != "Chrome_WidgetWin_1":
            return True
        _, wpid = win32process.GetWindowThreadProcessId(hwnd)
        if pid is not None and wpid != pid:
            return True
        ex = win32gui.GetWindowLong(hwnd, GWL_EXSTYLE)
        out.append(dict(hwnd=hwnd, pid=wpid, proc=process_name(wpid), title=win32gui.GetWindowText(hwnd),
                        ex=ex, topmost=bool(ex & WS_EX_TOPMOST), rect=win32gui.GetWindowRect(hwnd)))
        return True

    win32gui.EnumWindows(cb, None)
    return out


def set_ghost(hwnd, alpha=None, click_through=False):
    ex = win32gui.GetWindowLong(hwnd, GWL_EXSTYLE)
    ex |= WS_EX_LAYERED
    ex = ex | WS_EX_TRANSPARENT if click_through else ex & ~WS_EX_TRANSPARENT
    win32gui.SetWindowLong(hwnd, GWL_EXSTYLE, ex)
    win32gui.SetLayeredWindowAttributes(hwnd, 0, 255 if alpha is None else alpha, LWA_ALPHA)


def clear_ghost(hwnd):
    ex = win32gui.GetWindowLong(hwnd, GWL_EXSTYLE)
    win32gui.SetWindowLong(hwnd, GWL_EXSTYLE, ex & ~(WS_EX_LAYERED | WS_EX_TRANSPARENT))


def bring_topmost(hwnd):
    win32gui.SetWindowPos(hwnd, win32con.HWND_TOPMOST, 0, 0, 0, 0,
                          win32con.SWP_NOMOVE | win32con.SWP_NOSIZE | win32con.SWP_NOACTIVATE)


def serve_http():
    srv = ThreadingHTTPServer(("127.0.0.1", HTTP_PORT), partial(SimpleHTTPRequestHandler, directory=HERE))
    srv.RequestHandlerClass.log_message = lambda *a: None
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


class Chrome:
    def __init__(self, url, extra_args=()):
        self.profile = tempfile.mkdtemp(prefix="ghostpip-spike-")
        self.proc = subprocess.Popen([
            CHROME, f"--user-data-dir={self.profile}", f"--remote-debugging-port={CDP_PORT}",
            "--no-first-run", "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required",
            *extra_args, url])
        for _ in range(100):
            try:
                targets = json.load(urllib.request.urlopen(f"http://127.0.0.1:{CDP_PORT}/json"))
                page = next(t for t in targets if t["type"] == "page")
                break
            except Exception:
                time.sleep(0.2)
        self.ws = connect(page["webSocketDebuggerUrl"], max_size=None)
        self._id = 0
        wid = self.send("Browser.getWindowForTarget")["windowId"]
        self.send("Browser.setWindowBounds", windowId=wid,
                  bounds=dict(left=0, top=0, width=1280, height=900, windowState="normal"))

    def send(self, method, **params):
        self._id += 1
        self.ws.send(json.dumps(dict(id=self._id, method=method, params=params)))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self._id:
                if "error" in msg:
                    raise RuntimeError(msg["error"])
                return msg["result"]

    def eval(self, expr, gesture=False, timeout=30):
        r = self.send("Runtime.evaluate", expression=expr, awaitPromise=True, returnByValue=True,
                      userGesture=gesture, timeout=timeout * 1000)
        if "exceptionDetails" in r:
            return {"__error__": r["exceptionDetails"].get("exception", {}).get("description")
                    or r["exceptionDetails"].get("text")}
        return r["result"].get("value")

    def wait_for(self, expr, timeout=20):
        end = time.time() + timeout
        while time.time() < end:
            v = self.eval(expr)
            if v and not (isinstance(v, dict) and "__error__" in v):
                return v
            time.sleep(0.3)
        raise TimeoutError(expr)

    def navigate(self, url, wait=6):
        self.send("Page.navigate", url=url)
        time.sleep(wait)

    def close(self):
        try:
            self.send("Browser.close")
        except Exception:
            pass
        try:
            self.proc.wait(5)
        except Exception:
            self.proc.kill()

TEST_URL = 'file:///' + os.path.join(HERE, 'test.html').replace('\\', '/')

