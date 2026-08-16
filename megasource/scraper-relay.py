"""MegaSource CinemaBox scraper using the Android relay.

The relay runs on the user's Android phone, so CinemaBox API requests leave
through the phone's current Iraqi ISP/IP instead of the MegaSource server IP.

Configure RELAY_URL and RELAY_KEY below, or pass them through config as
config={'relay_url': 'https://...', 'relay_key': '...'} if the MegaSource UI
provides scraper config.
"""

import json
import re
import urllib.parse
import urllib.request

TITLE = "CinemaBox Iraq (Phone Relay)"
VERSION = "1.0.0"
DESCRIPTION = "CinemaBox through the user's Android/ISP relay"

RELAY_URL = "https://YOUR-TUNNEL.trycloudflare.com"
RELAY_KEY = "CHANGE_ME"
TMDB_API_KEY = "ee8ac8a9044c09a11cc362033f98c735"
BASE_URL = "https://cinema.albox.co/api/v4/"
UA = "Mozilla/5.0"


def _http(url, headers=None, timeout=25):
    req = urllib.request.Request(url, headers=headers or {"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8", errors="replace"))
    except Exception:
        return None


def _cfg(config):
    config = config if isinstance(config, dict) else {}
    relay = str(config.get("relay_url") or RELAY_URL).rstrip("/")
    key = str(config.get("relay_key") or RELAY_KEY)
    return relay, key


def _request(url, relay, key):
    # Only CinemaBox API calls go through the phone. TMDB can be called
    # directly because it is not the regional/IP-gated source.
    if url.startswith(BASE_URL):
        target = urllib.parse.quote(url, safe="")
        proxy = relay + "/proxy?url=" + target
        return _http(proxy, {"User-Agent": UA, "X-Relay-Key": key})
    return _http(url)


def _arr(x):
    if isinstance(x, list):
        return x
    if isinstance(x, dict):
        for k in ("results", "data", "items", "posts", "shows", "result"):
            if isinstance(x.get(k), list):
                return x[k]
    return []


def _id(x):
    if not isinstance(x, dict): return None
    for k in ("id", "show_id", "post_id", "nb", "_id", "uuid"):
        if x.get(k) is not None: return str(x[k])
    return None


def _title(x):
    if not isinstance(x, dict): return ""
    for k in ("name", "title", "en_name", "ar_name", "original_name", "post_title", "show_name", "show_title"):
        if x.get(k): return str(x[k])
    return ""


def _norm(x):
    x = str(x or "").lower()
    x = re.sub(r"[’'`]", "", x)
    return re.sub(r"[^a-z0-9\u0600-\u06ff]+", " ", x).strip()


def _match(x, titles):
    a = _norm(_title(x))
    return bool(a and any((b := _norm(t)) and (a == b or a in b or b in a) for t in titles))


def _num(x, keys):
    if not isinstance(x, dict): return None
    for k in keys:
        v = x.get(k)
        if v is not None:
            m = re.search(r"\d+", str(v))
            if m: return int(m.group())
    return None


def _season(x): return _num(x, ("season_number", "seasonNumber", "season", "number", "title"))
def _episode(x): return _num(x, ("episode_number", "episodeNumber", "description", "title", "episode"))


def _walk_seasons(x, out):
    if isinstance(x, list):
        for v in x: _walk_seasons(v, out)
    elif isinstance(x, dict):
        typ = str(x.get("card_type") or x.get("type") or "").lower()
        n, i = _season(x), _id(x)
        if n is not None and "season" in typ and i: out.append((n, i))
        for v in x.values(): _walk_seasons(v, out)


def _walk_episodes(x, out):
    if isinstance(x, list):
        for v in x: _walk_episodes(v, out)
    elif isinstance(x, dict):
        typ = str(x.get("card_type") or x.get("type") or "").lower()
        n, i = _episode(x), _id(x)
        if n is not None and "episode" in typ and i: out.append((n, i))
        for v in x.values(): _walk_episodes(v, out)


def _titles(tmdb_id):
    out=[]
    for lang in ("en", "ar"):
        q=urllib.parse.urlencode({"api_key":TMDB_API_KEY,"language":lang})
        d=_http("https://api.themoviedb.org/3/tv/%s?%s" % (urllib.parse.quote(str(tmdb_id)), q))
        if isinstance(d, dict):
            for k in ("name", "original_name"):
                v=str(d.get(k) or "").strip()
                if v and v not in out: out.append(v)
    return out


def _imdb_to_tmdb(imdb):
    q=urllib.parse.urlencode({"api_key":TMDB_API_KEY,"external_source":"imdb_id"})
    d=_http("https://api.themoviedb.org/3/find/%s?%s" % (urllib.parse.quote(imdb), q))
    if not isinstance(d, dict): return None
    tv=d.get("tv_results") or []
    return tv[0].get("id") if tv and isinstance(tv[0], dict) else None


def _dynamic(show_id, season_id, relay, key):
    u=BASE_URL+"shows/shows/dynamic/"+urllib.parse.quote(str(show_id))
    if season_id: u += "?"+urllib.parse.urlencode({"season_id":season_id})
    return _request(u, relay, key)


def _search(term, relay, key):
    q=urllib.parse.quote(term)
    out=[]
    for p in ("shows/search?q=", "search?q=", "search?query=", "search?term=", "search?search_term="):
        out += _arr(_request(BASE_URL+p+q, relay, key))
    return out


def _files(eid, ep, relay, key):
    d=_request(BASE_URL+"shows/episodes/"+urllib.parse.quote(str(eid))+"/files", relay, key)
    if not d: return []
    target=d
    if isinstance(d,dict) and isinstance(d.get("episodes"),list):
        for x in d["episodes"]:
            if _episode(x)==ep: target=x; break
    subs=[]; streams=[]

    def walk(x):
        if isinstance(x,list):
            for v in x: walk(v)
        elif isinstance(x,dict):
            if x.get("srt"):
                subs.append({"url":x["srt"],"lang":x.get("language") or "ar","label":"Arabic"})
            if x.get("vtt"):
                subs.append({"url":x["vtt"],"lang":x.get("language") or "ar","label":"Arabic"})
            u=x.get("url")
            if isinstance(u,str) and u.startswith("http"):
                q=str(x.get("quality") or ("1080p" if "1080" in u else "720p" if "720" in u else "480p" if "480" in u else "HD"))
                streams.append({"name":"CinemaBox","title":"CinemaBox "+q,"url":u,"quality":q})
            if x.get("videos"): walk(x["videos"])
    walk(target)
    if subs:
        for s in streams:
            s["subtitles"]=[{"url":x["url"],"lang":x["lang"],"label":x["label"]} for x in subs]
    return streams


def get_streams(media_type, media_id, config=None):
    if media_type != "series": return []
    parts=str(media_id).split(":")
    if len(parts)!=3: return []
    try: season, episode=int(parts[1]), int(parts[2])
    except ValueError: return []
    relay,key=_cfg(config)
    if "YOUR-TUNNEL" in relay or key == "CHANGE_ME": return []
    tmdb_id=_imdb_to_tmdb(parts[0])
    if not tmdb_id: return []
    titles=_titles(tmdb_id)
    for title in titles:
        for result in _search(title,relay,key):
            sid=_id(result)
            if not sid or not _match(result,titles): continue
            data=_dynamic(sid,None,relay,key)
            seasons=[]; _walk_seasons(data,seasons)
            for sn,season_id in seasons:
                if sn != season: continue
                sd=_dynamic(sid,season_id,relay,key)
                episodes=[]; _walk_episodes(sd,episodes)
                for en,episode_id in episodes:
                    if en == episode:
                        streams=_files(episode_id,episode,relay,key)
                        if streams: return streams
    return []
