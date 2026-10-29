"""H6: Mode 1 floating without detaching <video>. Variant A: position:fixed class. Variant B: popover top layer.
Measures where the video lands, whether it's the topmost element at that point, and whether playback continues."""
import base64
import json
import os
import sys
import time

from common import Chrome

OUT = os.path.join(os.path.dirname(__file__), "out")
os.makedirs(OUT, exist_ok=True)

CSS = """
@layer ghostpip { .gp-float { position: fixed !important; inset: auto 16px 16px auto !important; width: 480px !important;
  height: 270px !important; z-index: 2147483646 !important; margin: 0 !important; padding: 0 !important;
  border: 0 !important; background: #000 !important; transform: none !important; opacity: .7 !important;
  object-fit: contain !important; overflow: visible !important; } }
"""

PROBE = r"""
(async (variant) => {
  const v = [...document.querySelectorAll('video')].filter(x => x.videoWidth > 0)
            .sort((a, b) => b.videoWidth - a.videoWidth)[0];
  if (!v) return {error: 'no video'};
  if (!document.getElementById('gp-css')) {
    const s = document.createElement('style'); s.id = 'gp-css'; s.textContent = CSS; document.head.append(s);
  }
  const parent = v.parentNode, next = v.nextSibling, t0 = v.currentTime;
  if (variant === 'popover') { v.setAttribute('popover', 'manual'); v.classList.add('gp-float'); v.showPopover(); }
  else v.classList.add('gp-float');
  await new Promise(r => setTimeout(r, 1500));
  const r = v.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  const res = {variant, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
    viewport: [innerWidth, innerHeight], topmostAtCenter: hit === v, hitTag: hit && (hit.tagName + '.' + (hit.className || '').toString().slice(0, 30)),
    advanced: +(v.currentTime - t0).toFixed(2), sameParent: v.parentNode === parent && v.nextSibling === next,
    transformedAncestor: (() => { for (let a = v.parentElement; a; a = a.parentElement) { const cs = getComputedStyle(a);
      if (cs.transform !== 'none' || cs.filter !== 'none' || cs.contain.includes('paint') || cs.willChange.includes('transform')) return a.tagName + '#' + a.id + '.' + a.className.toString().slice(0, 30); } return null; })()};
  window._gpUndo = () => { if (v.matches(':popover-open')) v.hidePopover(); v.removeAttribute('popover'); v.classList.remove('gp-float'); };
  return res;
})
"""

URLS = {"youtube": "https://www.youtube.com/watch?v=jNQXAC9IVRw", "chzzk": None, "soop": None}
targets = sys.argv[1:] or ["youtube"]
ch = Chrome("about:blank")
for name in targets:
    url = URLS.get(name) or name
    ch.navigate(url, wait=8)
    ch.wait_for("[...document.querySelectorAll('video')].some(v => v.videoWidth > 0 && !v.paused)", timeout=30)
    ch.eval("window.scrollTo(0, 600)")
    for variant in ("fixed", "popover"):
        res = ch.eval(PROBE.replace("CSS", json.dumps(CSS)) + f"({json.dumps(variant)})", timeout=20)
        shot = ch.send("Page.captureScreenshot", format="png")["data"]
        tag = name if name in URLS else name.split("/")[2].split(".")[-2]
        path = os.path.join(OUT, f"h6_{tag}_{variant}.png")
        open(path, "wb").write(base64.b64decode(shot))
        print(tag, json.dumps(res, ensure_ascii=False), "->", path, flush=True)
        ch.eval("window._gpUndo && window._gpUndo()")
        time.sleep(1)
ch.close()
