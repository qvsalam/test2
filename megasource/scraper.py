"""MegaSource CinemaBox scraper using the Android/ISP relay in relay/config.json."""
import json, re, urllib.parse, urllib.request

TITLE = "CinemaBox Iraq (Phone Relay)"
VERSION = "3.0.0"
DESCRIPTION = "CinemaBox series through the user's Android ISP connection"
CONFIG_URL = "https://raw.githubusercontent.com/qvsalam/test2/main/relay/config.json"
TMDB_KEY = "ee8ac8a9044c09a11cc362033f98c735"
BASE = "https://cinema.albox.co/api/v4/"


def _raw(url, timeout=25):
    try:
        req = urllib.request.Request(url, headers={"User-Agent":"Mozilla/5.0","Accept":"application/json, text/plain, */*"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode("utf-8", errors="replace")
    except Exception:
        return ""


def _json(url):
    x=_raw(url)
    try: return json.loads(x) if x else None
    except Exception: return None


def _relay():
    c=_json(CONFIG_URL)
    if not isinstance(c,dict): return None
    base=str(c.get("base_url") or "").rstrip("/")
    token=str(c.get("token") or "")
    if not base or not token: return None
    return base+"/r/"+token


def _get(relay, url):
    if not relay: return None
    return _json(relay+"/fetch?url="+urllib.parse.quote(url,safe=""))


def _arr(x):
    if isinstance(x,list): return x
    if isinstance(x,dict):
        for k in ("results","data","items","posts","shows","result"):
            if isinstance(x.get(k),list): return x[k]
    return []


def _id(x):
    if not isinstance(x,dict): return None
    for k in ("id","show_id","post_id","nb","_id","uuid"):
        if x.get(k) is not None: return str(x[k])
    return None


def _title(x):
    if not isinstance(x,dict): return ""
    for k in ("name","title","en_name","ar_name","original_name","post_title","show_name","show_title"):
        if x.get(k): return str(x[k])
    return ""


def _norm(s): return re.sub(r"[^a-z0-9\u0600-\u06ff]+"," ",str(s or "").lower()).strip()

def _match(x,titles):
    a=_norm(_title(x))
    return bool(a) and any(b and (a==b or a in b or b in a) for b in (_norm(t) for t in titles))


def _num(x,keys):
    if not isinstance(x,dict): return None
    for k in keys:
        if x.get(k) is not None:
            m=re.search(r"\d+",str(x[k]))
            if m:return int(m.group())
    return None

def _season(x): return _num(x,("season_number","seasonNumber","season","number","title"))
def _episode(x): return _num(x,("episode_number","episodeNumber","description","title","episode"))


def _walk(v):
    if isinstance(v,list):
        for x in v: yield from _walk(x)
    elif isinstance(v,dict):
        yield v
        for x in v.values(): yield from _walk(x)


def _dynamic(relay,show,season_id=None):
    u=BASE+"shows/shows/dynamic/"+urllib.parse.quote(str(show))
    if season_id:u+="?season_id="+urllib.parse.quote(str(season_id))
    d=_get(relay,u)
    if isinstance(d,dict) and isinstance(d.get("data"),dict):d=d["data"]
    if isinstance(d,dict) and isinstance(d.get("result"),dict):d=d["result"]
    return d


def _seasons(d):
    out=[];seen=set()
    for x in _walk(d):
        ct=str(x.get("card_type") or x.get("type") or "").lower();n=_season(x);i=_id(x)
        if n is not None and "season" in ct and i and (n,i) not in seen:seen.add((n,i));out.append((n,i))
    return out


def _episodes(d):
    out=[];seen=set()
    for x in _walk(d):
        ct=str(x.get("card_type") or x.get("type") or "").lower();n=_episode(x);i=_id(x)
        if n is not None and "episode" in ct and i and (n,i) not in seen:seen.add((n,i));out.append((n,i))
    return out


def _tv_titles(relay,tmdb_id):
    out=[]
    for lang in ("en","ar"):
        u="https://api.themoviedb.org/3/tv/"+urllib.parse.quote(str(tmdb_id))+"?"+urllib.parse.urlencode({"api_key":TMDB_KEY,"language":lang})
        d=_get(relay,u)
        if isinstance(d,dict):
            for k in ("name","original_name"):
                v=str(d.get(k) or "").strip()
                if v and v not in out:out.append(v)
    return out


def _imdb_tv(relay,imdb):
    u="https://api.themoviedb.org/3/find/"+urllib.parse.quote(imdb)+"?"+urllib.parse.urlencode({"api_key":TMDB_KEY,"external_source":"imdb_id"})
    d=_get(relay,u)
    if isinstance(d,dict) and d.get("tv_results"):
        return d["tv_results"][0].get("id")
    return None


def _search(relay,title):
    q=urllib.parse.quote(title);out=[]
    for p in ("shows/search?q=","search?q=","search?query=","search?term=","search?search_term="):
        out+=_arr(_get(relay,BASE+p+q))
    return out


def _files(relay,eid,ep):
    d=_get(relay,BASE+"shows/episodes/"+urllib.parse.quote(str(eid))+"/files")
    if not d:return []
    target=d
    if isinstance(d,dict) and isinstance(d.get("episodes"),list):
        for e in d["episodes"]:
            if _episode(e)==ep:target=e;break
    subs=[];seen_sub=set()
    for x in _walk(target):
        lang=str(x.get("language") or "ar")
        for k in ("srt","vtt"):
            u=x.get(k)
            if isinstance(u,str) and u.startswith("http") and u not in seen_sub:
                seen_sub.add(u);subs.append((u,lang))
    streams=[];seen=set()
    for x in _walk(target):
        u=x.get("url")
        if not isinstance(u,str) or not u.startswith(("http://","https://")) or u in seen:continue
        seen.add(u)
        q=str(x.get("quality") or "") or ("1080p" if "1080" in u else "720p" if "720" in u else "480p" if "480" in u else "HD")
        su=relay+"/stream?url="+urllib.parse.quote(u,safe="")
        s={"name":"CinemaBox","title":"CinemaBox "+q,"url":su,"quality":q}
        if subs:s["subtitles"]=[{"url":relay+"/stream?url="+urllib.parse.quote(u2,safe=""),"lang":la,"label":"Arabic"} for u2,la in subs]
        streams.append(s)
    return streams


def get_streams(media_type,media_id,config=None):
    try:
        if media_type!="series":return []
        parts=str(media_id).split(":")
        if len(parts)!=3:return []
        season,episode=int(parts[1]),int(parts[2])
        relay=_relay()
        if not relay:return []
        tmdb_id=_imdb_tv(relay,parts[0])
        if not tmdb_id:return []
        titles=_tv_titles(relay,tmdb_id)
        for title in titles:
            for result in _search(relay,title):
                sid=_id(result)
                if not sid or not _match(result,titles):continue
                for sn,season_id in _seasons(_dynamic(relay,sid)):
                    if sn!=season:continue
                    for en,episode_id in _episodes(_dynamic(relay,sid,season_id)):
                        if en==episode:
                            found=_files(relay,episode_id,episode)
                            if found:return found
        return []
    except Exception:
        return []
