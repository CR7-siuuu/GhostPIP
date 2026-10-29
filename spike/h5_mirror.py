"""H5: Non-destructive mirroring. Does video.captureStream() of the site's own <video> produce live frames,
also inside a Document PiP window? Does the site's popout chat URL load in an iframe inside the PiP?"""
import json
import sys
import time

from common import Chrome

PROBE = r"""
(async () => {
  const vids = [...document.querySelectorAll('video')].filter(v => v.videoWidth > 0);
  if (!vids.length) return {error: 'no playing video', count: document.querySelectorAll('video').length};
  const v = vids.sort((a, b) => b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight)[0];
  const info = {src: (v.currentSrc || '').slice(0, 40), w: v.videoWidth, h: v.videoHeight, t0: v.currentTime, paused: v.paused};
  let stream;
  try { stream = v.captureStream(); } catch (e) { return {...info, error: 'captureStream: ' + e}; }
  info.videoTracks = stream.getVideoTracks().length;
  const pipMode = MODE === 'pip';
  let doc = document;
  if (pipMode) {
    const w = await documentPictureInPicture.requestWindow({width: 480, height: 600});
    w.document.body.style.cssText = 'margin:0;background:#000;display:flex;flex-direction:column;height:100vh';
    window._gp = w; doc = w.document;
  }
  const m = doc.createElement('video');
  m.muted = true; m.autoplay = true; m.playsInline = true; m.style.cssText = 'width:100%;flex:none';
  m.srcObject = stream; doc.body.append(m);
  await m.play().catch(e => info.playErr = String(e));
  await new Promise(r => setTimeout(r, 2500));
  const c = doc.createElement('canvas'); c.width = 64; c.height = 36;
  const g = c.getContext('2d');
  g.drawImage(m, 0, 0, 64, 36);
  let px;
  try { px = g.getImageData(0, 0, 64, 36).data; } catch (e) { info.canvasErr = String(e); }
  if (px) {
    let sum = 0, sq = 0; const n = px.length / 4;
    for (let i = 0; i < px.length; i += 4) { const l = (px[i] + px[i+1] + px[i+2]) / 3; sum += l; sq += l * l; }
    info.mirrorLuma = Math.round(sum / n); info.mirrorStd = Math.round(Math.sqrt(sq / n - (sum / n) ** 2));
  }
  info.mirrorSize = [m.videoWidth, m.videoHeight];
  info.origAdvanced = +(v.currentTime - info.t0).toFixed(2);
  info.origStillInPlace = v.isConnected && v.ownerDocument === document;
  if (pipMode && CHAT_URL) {
    const f = doc.createElement('iframe'); f.src = CHAT_URL; f.style.cssText = 'flex:1;border:0;width:100%';
    doc.body.append(f);
    await new Promise(r => setTimeout(r, 6000));
    try { info.chatTextLen = (f.contentDocument && f.contentDocument.body) ? f.contentDocument.body.innerText.length : -1; }
    catch (e) { info.chatErr = String(e).slice(0, 80); }
  }
  return info;
})()
"""

FIND = {
    "youtube_live": ("https://www.youtube.com/results?search_query=live&sp=EgJAAQ%253D%253D",
                     "[...document.querySelectorAll('a#video-title')].map(a=>a.href).find(h=>h.includes('/watch'))"),
    "chzzk": ("https://chzzk.naver.com/lives",
              "[...document.querySelectorAll('a[href*=\"/live/\"]')].map(a=>a.href)[0]"),
    "soop": ("https://www.sooplive.co.kr/",
             "[...document.querySelectorAll('a[href*=\"play.sooplive.\"]')].map(a=>a.href).find(h=>/\\/\\d+/.test(h))"),
    "twitch": ("https://www.twitch.tv/directory/all",
               "[...document.querySelectorAll('a[data-a-target=\"preview-card-image-link\"]')].map(a=>a.href)[0]"),
}


def chat_url(site, url):
    if site == "youtube_live":
        return f"https://www.youtube.com/live_chat?is_popout=1&v={url.split('v=')[1].split('&')[0]}"
    if site == "chzzk":
        return url.rstrip("/") + "/chat"
    if site == "twitch":
        return f"https://www.twitch.tv/popout/{url.rstrip('/').split('/')[-1]}/chat"
    return ""


sites = sys.argv[1:] or ["youtube_vod", *FIND]
ch = Chrome("about:blank")
report = {}
for site in sites:
    try:
        if site == "youtube_vod":
            url = "https://www.youtube.com/watch?v=jNQXAC9IVRw"
        else:
            ch.navigate(FIND[site][0], wait=7)
            url = ch.wait_for(FIND[site][1], timeout=15)
        ch.navigate(url, wait=12)
        r = {"url": url}
        for mode in ("tab", "pip"):
            expr = PROBE.replace("MODE", json.dumps(mode)).replace("CHAT_URL", json.dumps(chat_url(site, url)))
            r[mode] = ch.eval(expr, gesture=True, timeout=40)
            ch.eval("window._gp && window._gp.close()")
            time.sleep(1)
        report[site] = r
    except Exception as e:
        report[site] = {"error": repr(e)[:200]}
    print(site, json.dumps(report[site], ensure_ascii=False), flush=True)
ch.close()
