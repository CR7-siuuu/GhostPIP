"""H3: Can the engine identify native PiP and Document PiP windows? Does document.title reach the OS caption?"""
import json
import time
import uuid

from common import Chrome, TEST_URL, chrome_windows

ch = Chrome(TEST_URL)
ch.wait_for("typeof openDocPip === 'function' && document.getElementById('v').currentTime > 0.5")
pid = ch.proc.pid


def dump(label):
    print(f"--- {label}")
    for w in chrome_windows(pid):
        print(json.dumps({k: (hex(v) if k == "ex" else v) for k, v in w.items()}))


dump("baseline")
print("native:", ch.eval("openNativePip()", gesture=True))
time.sleep(1.5)
dump("native PiP open")
ch.eval("document.exitPictureInPicture()")
time.sleep(1)

nonce = "GhostPiP_Overlay#" + uuid.uuid4().hex[:8]
print("doc:", json.dumps(ch.eval(f"openDocPip({json.dumps(nonce)})", gesture=True)))
time.sleep(1.5)
dump("doc PiP open")
print("doc rect (later):", json.dumps(ch.eval("({x:_pip.screenX,y:_pip.screenY,w:_pip.outerWidth,h:_pip.outerHeight})")))
ch.eval(f"_pip.document.title = {json.dumps(nonce + '-changed')}; document.title = 'Opener Changed'")
time.sleep(1)
dump("after changing pip title + opener title")

print("no-gesture doc:", ch.eval("window._pip.close(); openDocPip('x')", gesture=False))
ch.close()
