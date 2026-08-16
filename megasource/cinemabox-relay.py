"""MegaSource CinemaBox scraper via an Android/ISP relay.

Set RELAY_BASE_URL to the public URL of the phone's Cloudflare Tunnel and
RELAY_KEY to the same value used by relay/relay.py.

Series media_id: tt1234567:1:2
Movie requests intentionally return [] because the existing test2 CinemaBox
provider exposes the TV/series endpoint only.
"""
import json
import re
import urllib.parse
import urllib.request

TITLE = "CinemaBox Iraq (Phone Relay)"
VERSION = "1.0.0"
DESCRIPTION = "CinemaBox through the user's Iraqi ISP connection"

RELAY_BASE_URL = "https://CHANGE-ME.trycloudflare.com"
RELAY_KEY = "CHANGE_ME"
TMDB_API_KEY = "ee8ac8a9044c09a11cc362033f98c735"
CINEMA_BASE = "https://cinema.albox.co/api/v4/"


def _request(url):
    relay = RELAY_BASE_URL.rstrip("/") + "/proxy?" + urllib.parse.urlencode({"url": url})
    req = urllib.request.Request(relay, headers={
        "Accept": "application/json, text/plain, */*",
        "User-Agent": "Mozilla/5.0 MegaSource",
        "X-Relay-Key": RELAY_KEY,
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8", errors="replace"))
    except Exception:
        return None


def _arr(x):
    if isinstance(x, list): return x
    if isinstance(x, dict):
        for k in ("results", "data", "items", "posts", "shows", "result"):
            if isinstance(x.get(k), list): return x[k]
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
    s = str(s or "").lower()
    s = re.sub(r"[’'`]", "", s)
    return re.sub(r"[^a-z0-9\u0600-\u06ff]+", " ", s).strip()


def _match(x, titles):
    a = _norm(_title(x))
    return bool(a and any(b and (a == b or a in b or b in a) for b in (_norm(t) for t in titles)))


def _num(x, keys):
    if not isinstance(x, dict): return None
    for k in keys:
        m = re.search(r"\d+", str(x.get(k, "")))
        if m: return int(m.group())
    return None


def _season(x): return _num(x, ("season_number", "seasonNumber", "season", "number", "title"))
def _episode(x): return _num(x, ("episode_number", "episodeNumber", "description", "title", "episode"))


def _walk_seasons(x, out):
    if isinstance(x, list):
        for y in x: _walk_seasons(y, out)
    elif isinstance(x, dict):
        typ = str(x.get("card_type") or x.get("type") or "").lower()
        sid = _id(x); sn = _season(x)
        if sid and sn is not None and "season" in typ: out.append((sn, sid))
        for y in x.values(): _walk_seasons(y, out)


def _walk_episodes(x, out):
    if isinstance(x, list):
        for y in x: _walk_episodes(y, out)
    elif isinstance(x, dict):
        typ = str(x.get("card_type") or x.get("type") or "").lower()
        eid = _id(x); en = _episode(x)
        if eid and en is not None and "episode" in typ: out.append((en, eid))
        for y in x.values(): _walk_episodes(y, out)


def _tmdb_titles(imdb_id):
    url = "https://api.themoviedb.org/3/find/{}?".format(urllib.parse.quote(imdb_id)) + urllib.parse.urlencode({"api_key": TMDB_API_KEY, "external_source": "imdb_id"})
    data = _request(url)
    # TMDB is not allow-listed by the phone relay, so fetch it directly if the relay rejects it.
    if not isinstance(data, dict):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent":"Mozilla/5.0"}), timeout=20) as r:
                data = json.loads(r.read().decode("utf-8", errors="replace"))
        except Exception:
            return [], None
    tv = data.get("tv_results") or []
    if not tv or not isinstance(tv[0], dict): return [], None
    tmdb_id = tv[0].get("id")
    titles = []
    for lang in ("en", "ar"):
        u = "https://api.themoviedb.org/3/tv/{}?".format(tmdb_id) + urllib.parse.urlencode({"api_key": TMDB_API_KEY, "language": lang})
        try:
            with urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent":"Mozilla/5.0"}), timeout=20) as r:
                d = json.loads(r.read().decode("utf-8", errors="replace"))
            for k in ("name", "original_name"):
                if d.get(k) and d[k] not in titles: titles.append(d[k])
        except Exception: pass
    return titles, tmdb_id


def _dynamic(show_id, season_id=None):
    u = CINEMA_BASE + "shows/shows/dynamic/" + urllib.parse.quote(str(show_id))
    if season_id: u += "?" + urllib.parse.urlencode({"season_id": season_id})
    return _request(u)


def _search(term):
    q = urllib.parse.quote(term)
    out = []
    for path in ("shows/search?q=", "search?q=", "search?query=", "search?term=", "search?search_term="):
        out += _arr(_request(CINEMA_BASE + path + q))
    return out


def _subtitles(data):
    out = []
    def walk(x):
        if isinstance(x, list):
            for y in x: walk(y)
        elif isinstance(x, dict):
            lang = x.get("language") or "ar"
            for key, fmt in (("srt", "srt"), ("vtt", "vtt")):
                if x.get(key): out.append({"url": x[key], "lang": lang, "language": lang, "title": "Arabic", "format": fmt})
            if x.get("subtitles"): walk(x["subtitles"])
    walk(data)
    return out


def _streams(data):
    subs = _subtitles(data); out = []; seen = set()
    def walk(x):
        if isinstance(x, list):
            for y in x: walk(y)
        elif isinstance(x, dict):
            u = x.get("url")
            if isinstance(u, str) and u.startswith("http") and u not in seen:
                seen.add(u)
                q = str(x.get("quality") or ("1080p" if "1080" in u else "720p" if "720" in u else "480p" if "480" in u else "HD"))
                s = {"name":"CinemaBox", "title":"CinemaBox " + q, "url":u}
                if subs:
                    s["subtitles"] = [{"url":z["url"], "lang":z["lang"], "language":z["language"], "label":z["title"]} for z in subs]
                out.append(s)
            if x.get("videos"): walk(x["videos"])
    walk(data)
    return out


def get_streams(media_type, media_id, config=None):
    try:
        if media_type != "series": return []
        parts = str(media_id).split(":")
        if len(parts) != 3: return []
        imdb, season, episode = parts[0], int(parts[1]), int(parts[2])
        titles, _ = _tmdb_titles(imdb)
        if not titles: return []
        for title in titles:
            for result in _search(title):
                show = _id(result)
                if not show or not _match(result, titles): continue
                data = _dynamic(show)
                seasons = []
                _walk_seasons(data, seasons)
                for sn, season_id in seasons:
                    if sn != season: continue
                    eps = []
                    _walk_episodes(_dynamic(show, season_id), eps)
                    for en, episode_id in eps:
                        if en == episode:
                            files = _request(CINEMA_BASE + "shows/episodes/" + urllib.parse.quote(str(episode_id)) + "/files")
                            if files:
                                found = _streams(files)
                                if found: return found
        return []
    except Exception:
        return []
