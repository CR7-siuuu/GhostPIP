import json, sys, time
from common import Chrome

ch = Chrome("about:blank")
ch.navigate("https://www.sooplive.co.kr/", wait=10)
print("soop links:", json.dumps(ch.eval(
    "[...new Set([...document.querySelectorAll('a[href]')].map(a=>a.href).filter(h=>/play\\.|\\/\\d{6,}/.test(h)))].slice(0,8)")))
for url in ["https://chzzk.naver.com/live/40bebcd63959291701da722988e10d30/chat", "https://www.twitch.tv/popout/serimm11/chat"]:
    ch.navigate(url, wait=12)
    print(url, json.dumps(ch.eval("document.body.innerText.slice(0,400)"), ensure_ascii=False))
ch.close()
