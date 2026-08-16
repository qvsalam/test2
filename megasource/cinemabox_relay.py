"""CinemaBox MegaSource scraper using the user's Android/ISP relay.

Series media_id: tt1234567:1:2

Set relay/relay.json with the public tunnel URL and private relay token before
using this scraper. Because MegaSource downloads this file from GitHub, do not
put a valuable/long-lived credential in a public repository; use a dedicated
throwaway token and rotate it if exposed.
"""
import json
import re
import urllib.parse
import urllib.request

TITLE = "CinemaBox Iraq (Phone Relay)"
VERSION = "1.1.0"
DESCRIPTION = "CinemaBox series scraper routed through the user's phone ISP"
TMDB_KEY = "ee8ac8a9044c09a11cc362033f98c735"
CB = "https://cinema.albox.co/api/v4/"
CONFIG_URL = "https://raw.githubusercontent.com/qvsalam/test2/main/relay/relay.json"
UA = "Mozilla/5.0 (Android) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36"
_relay = None


def _get(url, headers=None, timeout=30):
    try:
        req = urllib.request.Request(url, headers=headers or {"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", errors="replace")
            try:
                return json.loads(raw)
            except Exception:
                return raw
    except Exception:
        return None


def _relay_config():
    global _relay
    if _relay is not None:
        return _relay
    d = _get(CONFIG_URL)
    if isinstance(d, dict):
        _relay = (str(d.get("relay_url") or "").rstrip("/"), str(d.get("relay_token") or ""))
    else:
        _relay = ("", "")
    return _relay


def _cb_get(url):
    relay, token = _relay_config()
    if not relay or not token:
        return None
    q = urllib.parse.urlencode({"url": url, "key": token})
    return _get(relay + "/fetch?" + q, {"User-Agent": UA, "Accept": "application/json, text/plain, */*"})


def _relay_stream(url):
    relay, token = _relay_config()
    if not relay or not token:
        return url
    return relay + "/proxy?" + urllib.parse.urlencode({"url": url, "key": token})


def _tmdb_find(imdb):
    u = "https://api.themoviedb.org/3/find/" + urllib.parse.quote(imdb)
    q = urllib.parse.urlencode({"api_key": TMDB_KEY, "external_source": "imdb_id"})
    d = _get(u + "?" + q)
    if isinstance(d, dict) and d.get("tv_results"):
        return d["tv_results"][0]
    return None


def _titles(tid):
    out = []
    for lang in ("en", "ar"):
        q = urllib.parse.urlencode({"api_key": TMDB_KEY, "language": lang})
        d = _get("https://api.themoviedb.org/3/tv/" + str(tid) + "?" + q)
        if isinstance(d, dict):
            for k in ("name", "original_name"):
                v = str(d.get(k) or "").strip()
                if v and v not in out: out.append(v)
    return out


def _arr(v):
    if isinstance(v, list): return v
    if isinstance(v, dict):
        for k in ("results", "data", "items", "posts", "shows", "result"):
            if isinstance(v.get(k), list): return v[k]
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


def _norm(s):
    return re.sub(r"[^a-z0-9\u0600-\u06ff]+", " ", re.sub(r"[’'`]", "", str(s or "").lower())).strip()


def _match(x, titles):
    a = _norm(_title(x))
    return bool(a and any((b := _norm(t)) and (a == b or a in b or b in a) for t in titles))


def _num(x, keys):
    if not isinstance(x, dict): return None
    for k in keys:
        v = x.get(k)
        m = re.search(r"\d+", str(v)) if v is not None else None
        if m: return int(m.group())
    return None


def _walk(x):
    if isinstance(x, list):
        for v in x: yield from _walk(v)
    elif isinstance(x, dict):
        yield x
        for v in x.values(): yield from _walk(v)


def _seasons(data):
    out, seen = [], set()
    for x in _walk(data):
        typ = str(x.get("card_type") or x.get("type") or "").lower()
        n = _num(x, ("season_number", "seasonNumber", "season", "number", "title"))
        i = _id(x)
        if n is not None and "season" in typ and i and (n, i) not in seen:
            seen.add((n, i)); out.append((n, i))
    return out


def _episodes(data):
    out, seen = [], set()
    for x in _walk(data):
        typ = str(x.get("card_type") or x.get("type") or "").lower()
        n = _num(x, ("episode_number", "episodeNumber", "description", "title", "episode"))
        i = _id(x)
        if n is not None and "episode" in typ and i and (n, i) not in seen:
            seen.add((n, i)); out.append((n, i))
    return out


def _search(title):
    q = urllib.parse.quote(title)
    out = []
    for p in ("shows/search?q=", "search?q=", "search?query=", "search?term=", "search?search_term="):
        out.extend(_arr(_cb_get(CB + p + q)))
    return out


def _dynamic(show, season=None):
    u = CB + "shows/shows/dynamic/" + urllib.parse.quote(str(show))
    if season: u += "?" + urllib.parse.urlencode({"season_id": season})
    d = _cb_get(u)
    if isinstance(d, dict) and isinstance(d.get("data"), dict): d = d["data"]
    if isinstance(d, dict) and isinstance(d.get("result"), dict): d = d["result"]
    return d


def _subs(data):
    out, seen = [], set()
    for x in _walk(data):
        for k in ("srt", "vtt"):
            u = x.get(k)
            if isinstance(u, str) and u.startswith("http") and u not in seen:
                seen.add(u); out.append({"url": _relay_stream(u), "lang": str(x.get("language") or "ar"), "label": "Arabic"})
    return out


def _streams(data):
    subs = _subs(data)
    out, seen = [], set()
    for x in _walk(data):
        u = x.get("url")
        if not isinstance(u, str) or not u.startswith("http") or u in seen: continue
        seen.add(u)
        q = str(x.get("quality") or "")
        if not q: q = "1080p" if "1080" in u else "720p" if "720" in u else "480p" if "480" in u else "HD"
        s = {"name": "CinemaBox", "title": "CinemaBox " + q, "url": _relay_stream(u), "quality": q}
        if subs: s["subtitles"] = subs
        out.append(s)
    return out


def _files(eid, ep):
    d = _cb_get(CB + "shows/episodes/" + urllib.parse.quote(str(eid)) + "/files")
    if isinstance(d, dict) and isinstance(d.get("episodes"), list):
        for x in d["episodes"]:
            if _num(x, ("episode_number", "episodeNumber", "description", "title", "episode")) == ep: return _streams(x)
    return _streams(d) if d else []


def _series(imdb, season, episode):
    tm = _tmdb_find(imdb)
    if not tm or not tm.get("id"): return []
    titles = _titles(tm["id"])
    for title in titles:
        for result in _search(title):
            show = _id(result)
            if not show or not _match(result, titles): continue
            for sn, sid in _seasons(_dynamic(show)):
                if sn != season: continue
                for en, eid in _episodes(_dynamic(show, sid)):
                    if en == episode:
                        got = _files(eid, episode)
                        if got: return got
    return []


def get_streams(media_type, media_id, config=None):
    global _relay
    if isinstance(config, dict) and config.get("relay_url"):
        _relay = (str(config["relay_url"]).rstrip("/"), str(config.get("relay_token") or ""))
    if media_type != "series": return []
    p = str(media_id).split(":")
    if len(p) != 3: return []
    try: return _series(p[0], int(p[1]), int(p[2]))
    except Exception: return []
