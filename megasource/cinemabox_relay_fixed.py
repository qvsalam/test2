"""MegaSource CinemaBox series scraper via the Android ISP relay.

Configure relay/relay.json with:
  {"relay_url":"https://xxxx.trycloudflare.com/fetch","relay_token":"YOUR_KEY"}

The phone relay receives the CinemaBox API URL and performs the request from
its own mobile/ISP connection. TMDB requests are made directly by MegaSource.
"""
import json, re, ssl, urllib.parse, urllib.request

TITLE = "CinemaBox Iraq (Phone Relay)"
VERSION = "1.0.0"
DESCRIPTION = "CinemaBox series through Android ISP relay"
TMDB_KEY = "ee8ac8a9044c09a11cc362033f98c735"
CB = "https://cinema.albox.co/api/v4/"
CFG = "https://raw.githubusercontent.com/qvsalam/test2/main/relay/relay.json"
_relay = None


def get_json(url, headers=None):
    try:
        r = urllib.request.Request(url, headers=headers or {"User-Agent":"Mozilla/5.0"})
        with urllib.request.urlopen(r, timeout=25, context=ssl.create_default_context()) as x:
            if not 200 <= x.status < 300: return None
            return json.loads(x.read().decode("utf-8", errors="replace"))
    except Exception: return None


def relay_cfg():
    global _relay
    if _relay is None:
        d=get_json(CFG) or {}
        _relay=(str(d.get("relay_url") or "").rstrip("/"), str(d.get("relay_token") or ""))
    return _relay


def cb(url):
    base,key=relay_cfg()
    if not base: return None
    return get_json(base+"?"+urllib.parse.urlencode({"url":url,"key":key}), {"User-Agent":"Mozilla/5.0 (Android)"})


def walk(v):
    if isinstance(v,list):
        for x in v: yield from walk(x)
    elif isinstance(v,dict):
        yield v
        for x in v.values(): yield from walk(x)


def arr(v):
    if isinstance(v,list): return v
    if isinstance(v,dict):
        for k in ("results","data","items","posts","shows","result"):
            if isinstance(v.get(k),list): return v[k]
    return []


def ident(x):
    return str(next((x[k] for k in ("id","show_id","post_id","nb","_id","uuid") if isinstance(x,dict) and x.get(k) is not None),""))


def title(x):
    return str(next((x[k] for k in ("name","title","en_name","ar_name","original_name","post_title","show_name","show_title") if isinstance(x,dict) and x.get(k)),""))


def norm(s): return re.sub(r"[^a-z0-9\u0600-\u06ff]+"," ",str(s or "").lower()).strip()

def num(x,keys):
    if not isinstance(x,dict): return None
    for k in keys:
        m=re.search(r"\d+",str(x.get(k,"")))
        if m:return int(m.group())
    return None


def get_streams(media_type, media_id, config=None):
    if media_type!="series": return []
    p=str(media_id).split(":")
    if len(p)!=3:return []
    imdb,season,episode=p[0],int(p[1]),int(p[2])

    # TMDB lookup is outside the ISP-bound source.
    u="https://api.themoviedb.org/3/find/"+urllib.parse.quote(imdb)
    d=get_json(u+"?"+urllib.parse.urlencode({"api_key":TMDB_KEY,"external_source":"imdb_id"})) or {}
    tv=d.get("tv_results") or []
    if not tv:return []
    tid=tv[0].get("id")
    names=[]
    for lang in ("en","ar"):
        d=get_json("https://api.themoviedb.org/3/tv/"+str(tid)+"?"+urllib.parse.urlencode({"api_key":TMDB_KEY,"language":lang})) or {}
        for k in ("name","original_name"):
            if d.get(k) and d[k] not in names:names.append(d[k])

    for name in names:
        q=urllib.parse.quote(name)
        for path in ("shows/search?q=","search?q=","search?query=","search?term=","search?search_term="):
            for result in arr(cb(CB+path+q)):
                rt=norm(title(result))
                if not rt or not any(rt==norm(n) or rt in norm(n) or norm(n) in rt for n in names):continue
                show=ident(result)
                if not show:continue
                d=cb(CB+"shows/shows/dynamic/"+urllib.parse.quote(show))
                seasons=[]
                for x in walk(d):
                    typ=str(x.get("card_type") or x.get("type") or "").lower()
                    sn=num(x,("season_number","seasonNumber","season","number","title"))
                    sid=ident(x)
                    if sn is not None and "season" in typ and sid:seasons.append((sn,sid))
                for sn,sid in seasons:
                    if sn!=season:continue
                    sd=cb(CB+"shows/shows/dynamic/"+urllib.parse.quote(show)+"?"+urllib.parse.urlencode({"season_id":sid}))
                    for x in walk(sd):
                        typ=str(x.get("card_type") or x.get("type") or "").lower()
                        en=num(x,("episode_number","episodeNumber","description","title","episode"))
                        eid=ident(x)
                        if en!=episode or "episode" not in typ or not eid:continue
                        fd=cb(CB+"shows/episodes/"+urllib.parse.quote(eid)+"/files")
                        streams=[];subs=[];seen=set()
                        for z in walk(fd):
                            for k in ("srt","vtt"):
                                if isinstance(z.get(k),str) and z[k].startswith("http") and z[k] not in subs:subs.append(z[k])
                            url=z.get("url")
                            if isinstance(url,str) and url.startswith("http") and url not in seen:
                                seen.add(url);qv=str(z.get("quality") or "HD")
                                streams.append({"name":"CinemaBox","title":"CinemaBox "+qv,"url":url})
                        if subs:
                            for s in streams:s["subtitles"]=[{"url":u,"lang":"ar","label":"Arabic"} for u in subs]
                        if streams:return streams
    return []
