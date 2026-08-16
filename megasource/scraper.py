"""CinemaBox -> MegaSource scraper with optional Android/ISP relay.

MegaSource IDs:
  series: tt1234567:1:2

If CinemaBox/TMDB only work from the user's Iraqi ISP, set RELAY_URL and
RELAY_TOKEN below to the public URL/token of relay/server.py running on the
phone. The relay fetches the API from the phone's own connection.
"""

import json
import os
import re
import ssl
import urllib.error
import urllib.parse
import urllib.request

TITLE = "CinemaBox Iraq"
VERSION = "2.0.0"
DESCRIPTION = "CinemaBox series scraper with optional phone/ISP relay"

TMDB_API_KEY = "ee8ac8a9044c09a11cc362033f98c735"
BASE_URL = "https://cinema.albox.co/api/v4/"
UA = "Mozilla/5.0 (Android) AppleWebKit/537.36 Chrome/137.0 Mobile Safari/537.36"

# Leave empty until the phone relay is running. Then put its /fetch URL here.
# Example: https://xxxx.trycloudflare.com/fetch
RELAY_URL = ""
RELAY_TOKEN = ""


def _request(url, config=None):
    relay = RELAY_URL
    token = RELAY_TOKEN
    if isinstance(config, dict):
        relay = str(config.get("relay_url") or relay).strip()
        token = str(config.get("relay_token") or token).strip()

    try:
        if relay:
            # The relay only permits approved upstream hosts.
            target = urllib.parse.quote(url, safe="")
            request_url = relay.rstrip("/") + "?url=" + target
            headers = {"X-Relay-Token": token, "Accept": "application/json, text/plain, */*"}
        else:
            request_url = url
            headers = {"Accept": "application/json, text/plain, */*", "User-Agent": UA}

        req = urllib.request.Request(request_url, headers=headers)
        ctx = ssl.create_default_context()
        with urllib.request.urlopen(req, timeout=25, context=ctx) as r:
            if r.status < 200 or r.status >= 300:
                return None
            return json.loads(r.read().decode("utf-8", errors="replace"))
    except Exception:
        return None


def _arr(v):
    if isinstance(v, list):
        return v
    if isinstance(v, dict):
        for k in ("results", "data", "items", "posts", "shows", "result"):
            if isinstance(v.get(k), list):
                return v[k]
    return []


def _id(x):
    if not isinstance(x, dict):
        return None
    for k in ("id", "show_id", "post_id", "nb", "_id", "uuid"):
        if x.get(k) is not None:
            return str(x[k])
    return None


def _title(x):
    if not isinstance(x, dict):
        return ""
    for k in ("name", "title", "en_name", "ar_name", "original_name", "post_title", "show_name", "show_title"):
        if x.get(k):
            return str(x[k])
    return ""


def _norm(s):
    s = str(s or "").lower()
    s = re.sub(r"[’'`]", "", s)
    return re.sub(r"[^a-z0-9\u0600-\u06ff]+", " ", s).strip()


def _match(x, titles):
    a = _norm(_title(x))
    return bool(a and any(b and (a == b or a in b or b in a) for b in (_norm(t) for t in titles)))


def _num(x, keys):
    if not isinstance(x, dict):
        return None
    for k in keys:
        v = x.get(k)
        m = re.search(r"\d+", str(v)) if v is not None else None
        if m:
            return int(m.group())
    return None


def _season(x):
    return _num(x, ("season_number", "seasonNumber", "season", "number", "title"))


def _episode(x):
    return _num(x, ("episode_number", "episodeNumber", "description", "title", "episode"))


def _tmdb_find(imdb_id, config):
    url = "https://api.themoviedb.org/3/find/" + urllib.parse.quote(imdb_id)
    q = urllib.parse.urlencode({"api_key": TMDB_API_KEY, "external_source": "imdb_id"})
    d = _request(url + "?" + q, config)
    if not isinstance(d, dict):
        return None
    tv = d.get("tv_results") or []
    return tv[0] if tv and isinstance(tv[0], dict) else None


def _tmdb_titles(tmdb_id, config):
    url = "https://api.themoviedb.org/3/tv/" + urllib.parse.quote(str(tmdb_id))
    out = []
    for lang in ("en", "ar"):
        q = urllib.parse.urlencode({"api_key": TMDB_API_KEY, "language": lang})
        d = _request(url + "?" + q, config)
        if isinstance(d, dict):
            for k in ("name", "original_name"):
                v = str(d.get(k) or "").strip()
                if v and v not in out:
                    out.append(v)
    return out


def _dynamic(show_id, season_id, config):
    u = BASE_URL + "shows/shows/dynamic/" + urllib.parse.quote(str(show_id))
    if season_id:
        u += "?" + urllib.parse.urlencode({"season_id": season_id})
    d = _request(u, config)
    if isinstance(d, dict) and isinstance(d.get("data"), dict):
        d = d["data"]
    if isinstance(d, dict) and isinstance(d.get("result"), dict):
        d = d["result"]
    return d


def _walk(value):
    if isinstance(value, list):
        for x in value:
            yield from _walk(x)
    elif isinstance(value, dict):
        yield value
        for x in value.values():
            yield from _walk(x)


def _seasons(data):
    out = []
    seen = set()
    for x in _walk(data):
        ct = str(x.get("card_type") or x.get("type") or "").lower()
        n, i = _season(x), _id(x)
        if n is not None and "season" in ct and i and (n, i) not in seen:
            seen.add((n, i)); out.append((n, i))
    return out


def _episodes(data):
    out = []
    seen = set()
    for x in _walk(data):
        ct = str(x.get("card_type") or x.get("type") or "").lower()
        n, i = _episode(x), _id(x)
        if n is not None and "episode" in ct and i and (n, i) not in seen:
            seen.add((n, i)); out.append((n, i))
    return out


def _subtitles(data):
    out = []
    seen = set()
    for x in _walk(data):
        for key in ("srt", "vtt"):
            u = x.get(key)
            if isinstance(u, str) and u.startswith("http") and u not in seen:
                seen.add(u)
                lang = str(x.get("language") or "ar")
                out.append({"url": u, "lang": lang, "language": lang, "label": "Arabic"})
    return out


def _streams(data):
    subs = _subtitles(data)
    out, seen = [], set()
    for x in _walk(data):
        u = x.get("url")
        if not isinstance(u, str) or not re.match(r"^https?://", u) or u in seen:
            continue
        seen.add(u)
        q = str(x.get("quality") or "")
        if not q:
            q = "1080p" if "1080" in u else "720p" if "720" in u else "480p" if "480" in u else "HD"
        s = {"name": "CinemaBox", "title": "CinemaBox " + q, "url": u}
        if subs:
            s["subtitles"] = subs
        out.append(s)
    return out


def _search(title, config):
    q = urllib.parse.quote(title)
    paths = ("shows/search?q=", "search?q=", "search?query=", "search?term=", "search?search_term=")
    out = []
    for p in paths:
        out.extend(_arr(_request(BASE_URL + p + q, config)))
    return out


def _episode_files(eid, number, config):
    d = _request(BASE_URL + "shows/episodes/" + urllib.parse.quote(str(eid)) + "/files", config)
    if not d:
        return []
    if isinstance(d, dict) and isinstance(d.get("episodes"), list):
        for e in d["episodes"]:
            if _episode(e) == number:
                return _streams(e)
    return _streams(d)


def _series(imdb_id, season, episode, config):
    tmdb = _tmdb_find(imdb_id, config)
    if not tmdb or not tmdb.get("id"):
        return []
    titles = _tmdb_titles(tmdb["id"], config)
    if not titles:
        return []

    for title in titles:
        for result in _search(title, config):
            show_id = _id(result)
            if not show_id or not _match(result, titles):
                continue
            for sn, sid in _seasons(_dynamic(show_id, None, config)):
                if sn != season:
                    continue
                for en, eid in _episodes(_dynamic(show_id, sid, config)):
                    if en == episode:
                        streams = _episode_files(eid, episode, config)
                        if streams:
                            return streams
    return []


def get_streams(media_type, media_id, config=None):
    if media_type != "series":
        return []
    parts = str(media_id).split(":")
    if len(parts) != 3:
        return []
    try:
        return _series(parts[0], int(parts[1]), int(parts[2]), config)
    except Exception:
        return []
