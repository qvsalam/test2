"""MegaSource CinemaBox scraper backed by the Android phone relay.

The phone relay is qvsalam/test2/relay/server.py. It performs CinemaBox API
requests and can also proxy returned .albox.co streams through the same phone.

Set RELAY_URL to the public Cloudflare Tunnel URL and RELAY_TOKEN to the same
value used by the phone relay. MegaSource can also pass relay_url/relay_token
in config when supported.
"""

import json
import re
import urllib.parse
import urllib.request

TITLE = "CinemaBox Iraq • Phone Relay"
VERSION = "1.0.0"
DESCRIPTION = "CinemaBox through the user's Iraqi ISP connection"
RELAY_URL = "https://YOUR-TUNNEL.trycloudflare.com"
RELAY_TOKEN = "CHANGE_ME"
TMDB_API_KEY = "ee8ac8a9044c09a11cc362033f98c735"
BASE = "https://cinema.albox.co/api/v4/"
UA = "Mozilla/5.0"


def http_json(url, headers=None):
    try:
        req = urllib.request.Request(url, headers=headers or {"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8", errors="replace"))
    except Exception:
        return None


def cfg(config):
    c = config if isinstance(config, dict) else {}
    return str(c.get("relay_url") or RELAY_URL).rstrip("/"), str(c.get("relay_token") or RELAY_TOKEN)


def cb(url, relay, token):
    target = urllib.parse.quote(url, safe="")
    endpoint = f"{relay}/r/{urllib.parse.quote(token, safe='')}/fetch?url={target}"
    return http_json(endpoint)


def arr(x):
    if isinstance(x, list): return x
    if isinstance(x, dict):
        for k in ("results","data","items","posts","shows","result"):
            if isinstance(x.get(k), list): return x[k]
    return []


def ident(x):
    if not isinstance(x, dict): return None
    for k in ("id","show_id","post_id","nb","_id","uuid"):
        if x.get(k) is not None: return str(x[k])
    return None


def title(x):
    if not isinstance(x, dict): return ""
    for k in ("name","title","en_name","ar_name","original_name","post_title","show_name","show_title"):
        if x.get(k): return str(x[k])
    return ""


def norm(x):
    x = re.sub(r"[’'`]", "", str(x or "").lower())
    return re.sub(r"[^a-z0-9\u0600-\u06ff]+", " ", x).strip()


def match(x, titles):
    a = norm(title(x))
    return bool(a and any((b := norm(t)) and (a == b or a in b or b in a) for t in titles))


def num(x, keys):
    if not isinstance(x, dict): return None
    for k in keys:
        v=x.get(k)
        if v is not None:
            m=re.search(r"\d+",str(v))
            if m: return int(m.group())
    return None


def walk_seasons(x,out):
    if isinstance(x,list):
        for v in x: walk_seasons(v,out)
    elif isinstance(x,dict):
        typ=str(x.get("card_type") or x.get("type") or "").lower()
        n=num(x,("season_number","seasonNumber","season","number","title")); i=ident(x)
        if n is not None and "season" in typ and i: out.append((n,i))
        for v in x.values(): walk_seasons(v,out)


def walk_episodes(x,out):
    if isinstance(x,list):
        for v in x: walk_episodes(v,out)
    elif isinstance(x,dict):
        typ=str(x.get("card_type") or x.get("type") or "").lower()
        n=num(x,("episode_number","episodeNumber","description","title","episode")); i=ident(x)
        if n is not None and "episode" in typ and i: out.append((n,i))
        for v in x.values(): walk_episodes(v,out)


def tmdb_titles(tid):
    out=[]
    for lang in ("en","ar"):
        q=urllib.parse.urlencode({"api_key":TMDB_API_KEY,"language":lang})
        d=http_json(f"https://api.themoviedb.org/3/tv/{urllib.parse.quote(str(tid))}?{q}")
        if isinstance(d,dict):
            for k in ("name","original_name"):
                v=str(d.get(k) or "").strip()
                if v and v not in out: out.append(v)
    return out


def imdb_to_tmdb(imdb):
    q=urllib.parse.urlencode({"api_key":TMDB_API_KEY,"external_source":"imdb_id"})
    d=http_json(f"https://api.themoviedb.org/3/find/{urllib.parse.quote(imdb)}?{q}")
    tv=(d or {}).get("tv_results") if isinstance(d,dict) else None
    return tv[0].get("id") if tv and isinstance(tv[0],dict) else None


def dynamic(show, season, relay, token):
    u=BASE+"shows/shows/dynamic/"+urllib.parse.quote(str(show))
    if season: u += "?"+urllib.parse.urlencode({"season_id":season})
    return cb(u,relay,token)


def search(term, relay, token):
    q=urllib.parse.quote(term); out=[]
    for p in ("shows/search?q=","search?q=","search?query=","search?term=","search?search_term="):
        out += arr(cb(BASE+p+q,relay,token))
    return out


def files(eid, ep, relay, token):
    d=cb(BASE+"shows/episodes/"+urllib.parse.quote(str(eid))+"/files",relay,token)
    if not d: return []
    target=d
    if isinstance(d,dict) and isinstance(d.get("episodes"),list):
        for x in d["episodes"]:
            if num(x,("episode_number","episodeNumber","description","title","episode"))==ep:
                target=x; break
    subs=[]; streams=[]
    def walk(x):
        if isinstance(x,list):
            for v in x: walk(v)
        elif isinstance(x,dict):
            lang=x.get("language") or "ar"
            if x.get("srt"): subs.append({"url":x["srt"],"lang":lang,"label":"Arabic"})
            if x.get("vtt"): subs.append({"url":x["vtt"],"lang":lang,"label":"Arabic"})
            u=x.get("url")
            if isinstance(u,str) and u.startswith("http"):
                q=str(x.get("quality") or ("1080p" if "1080" in u else "720p" if "720" in u else "480p" if "480" in u else "HD"))
                streams.append((u,q))
            if x.get("videos"): walk(x["videos"])
    walk(target)
    out=[]; seen=set()
    for u,q in streams:
        if u in seen: continue
        seen.add(u)
        prox=f"{relay}/r/{urllib.parse.quote(token,safe='')}/stream?url={urllib.parse.quote(u,safe='')}"
        s={"name":"CinemaBox Iraq","title":"CinemaBox "+q,"url":prox,"quality":q}
        if subs:
            s["subtitles"]=subs
        out.append(s)
    return out


def get_streams(media_type, media_id, config=None):
    if media_type != "series": return []
    p=str(media_id).split(":")
    if len(p)!=3: return []
    try: season,episode=int(p[1]),int(p[2])
    except ValueError: return []
    relay,token=cfg(config)
    if "YOUR-TUNNEL" in relay or token=="CHANGE_ME": return []
    tid=imdb_to_tmdb(p[0])
    if not tid: return []
    titles=tmdb_titles(tid)
    for t in titles:
        for result in search(t,relay,token):
            sid=ident(result)
            if not sid or not match(result,titles): continue
            seasons=[]; walk_seasons(dynamic(sid,None,relay,token),seasons)
            for sn,season_id in seasons:
                if sn!=season: continue
                eps=[]; walk_episodes(dynamic(sid,season_id,relay,token),eps)
                for en,eid in eps:
                    if en==episode:
                        got=files(eid,episode,relay,token)
                        if got: return got
    return []
