"""MegaSource adapter for the CinemaBox provider from qvsalam/test2.

Protocol:
    get_streams(media_type, media_id, config=None) -> list[dict]

MegaSource media_id format:
    movie  -> tt1234567
    series -> tt1234567:1:2

This adapter mirrors the CinemaBox JS provider in providers/cinemabox-apk.js.
Only Python standard-library modules are used.
"""

import http.cookiejar
import json
import re
import urllib.error
import urllib.parse
import urllib.request

TITLE = "CinemaBox Iraq"
VERSION = "1.0.0"
DESCRIPTION = "CinemaBox provider converted from qvsalam/test2"

TMDB_API_KEY = "ee8ac8a9044c09a11cc362033f98c735"
BASE_URL = "https://cinema.albox.co/api/v4/"
USER_AGENT = "Mozilla/5.0"

_cookiejar = http.cookiejar.CookieJar()
_opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_cookiejar))


def _request(url):
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json, text/plain, */*",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with _opener.open(req, timeout=15) as response:
            if response.status < 200 or response.status >= 300:
                return None
            return json.loads(response.read().decode("utf-8", errors="replace"))
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError, OSError):
        return None


def _arr(value):
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        for key in ("results", "data", "items", "posts", "shows", "result"):
            candidate = value.get(key)
            if isinstance(candidate, list):
                return candidate
    return []


def _id(item):
    if not isinstance(item, dict):
        return None
    for key in ("id", "show_id", "post_id", "nb", "_id", "uuid"):
        if item.get(key) is not None:
            return str(item[key])
    return None


def _title(item):
    if not isinstance(item, dict):
        return ""
    for key in (
        "name", "title", "en_name", "ar_name", "original_name",
        "post_title", "show_name", "show_title",
    ):
        value = item.get(key)
        if value:
            return str(value)
    return ""


def _normalise(value):
    value = str(value or "").lower()
    value = re.sub(r"[’'`]", "", value)
    value = re.sub(r"[^a-z0-9\u0600-\u06ff]+", " ", value)
    return value.strip()


def _matches(item, titles):
    current = _normalise(_title(item))
    if not current:
        return False
    for title in titles:
        target = _normalise(title)
        if target and (current == target or target in current or current in target):
            return True
    return False


def _number(item, keys):
    if not isinstance(item, dict):
        return None
    for key in keys:
        value = item.get(key)
        if value is None:
            continue
        match = re.search(r"\d+", str(value))
        if match:
            return int(match.group(0))
    return None


def _episode_number(item):
    return _number(item, ("episode_number", "episodeNumber", "description", "title", "episode"))


def _season_number(item):
    return _number(item, ("season_number", "seasonNumber", "season", "number", "title"))


def _tmdb_tv_titles(tmdb_id):
    url = "https://api.themoviedb.org/3/tv/{}".format(urllib.parse.quote(str(tmdb_id)))
    titles = []
    for language in ("en", "ar"):
        query = urllib.parse.urlencode({"api_key": TMDB_API_KEY, "language": language})
        data = _request(url + "?" + query)
        if isinstance(data, dict):
            for key in ("name", "original_name"):
                value = str(data.get(key) or "").strip()
                if value and value not in titles:
                    titles.append(value)
    return titles


def _imdb_to_tmdb(imdb_id):
    url = "https://api.themoviedb.org/3/find/{}".format(
        urllib.parse.quote(imdb_id)
    )
    query = urllib.parse.urlencode(
        {"api_key": TMDB_API_KEY, "external_source": "imdb_id"}
    )
    data = _request(url + "?" + query)
    if not isinstance(data, dict):
        return None
    movies = data.get("movie_results") or []
    tv = data.get("tv_results") or []
    if movies and isinstance(movies[0], dict):
        return {"type": "movie", "id": movies[0].get("id")}
    if tv and isinstance(tv[0], dict):
        return {"type": "tv", "id": tv[0].get("id")}
    return None


def _dynamic(show_id, season_id=None):
    url = BASE_URL + "shows/shows/dynamic/" + urllib.parse.quote(str(show_id))
    if season_id:
        url += "?" + urllib.parse.urlencode({"season_id": season_id})
    data = _request(url)
    if isinstance(data, dict):
        if isinstance(data.get("data"), dict):
            data = data["data"]
        if isinstance(data.get("result"), dict):
            data = data["result"]
    return data


def _find_seasons(data):
    found = []

    def walk(value):
        if isinstance(value, list):
            for item in value:
                walk(item)
            return
        if not isinstance(value, dict):
            return
        card_type = str(value.get("card_type") or value.get("type") or "").lower()
        season = _season_number(value)
        item_id = _id(value)
        if season is not None and "season" in card_type and item_id:
            found.append((season, item_id))
        for child in value.values():
            walk(child)

    walk(data)
    return found


def _find_episodes(data):
    found = []

    def walk(value):
        if isinstance(value, list):
            for item in value:
                walk(item)
            return
        if not isinstance(value, dict):
            return
        card_type = str(value.get("card_type") or value.get("type") or "").lower()
        episode = _episode_number(value)
        item_id = _id(value)
        if episode is not None and "episode" in card_type and item_id:
            found.append((episode, item_id))
        for child in value.values():
            walk(child)

    walk(data)
    return found


def _subtitles(data):
    result = []

    def walk(value):
        if isinstance(value, list):
            for item in value:
                walk(item)
            return
        if not isinstance(value, dict):
            return
        language = value.get("language") or "ar"
        if value.get("srt"):
            result.append({
                "url": value["srt"],
                "lang": language,
                "language": language,
                "title": "Arabic",
            })
        if value.get("vtt"):
            result.append({
                "url": value["vtt"],
                "lang": language,
                "language": language,
                "title": "Arabic",
            })
        if value.get("subtitles"):
            walk(value["subtitles"])

    walk(data)
    return result


def _quality(url, value=None):
    if value:
        return str(value)
    if re.search(r"1080", url, re.I):
        return "1080p"
    if re.search(r"720", url, re.I):
        return "720p"
    if re.search(r"480", url, re.I):
        return "480p"
    return "HD"


def _streams_from_data(data):
    subtitles = _subtitles(data)
    streams = []
    seen = set()

    def walk(value):
        if isinstance(value, list):
            for item in value:
                walk(item)
            return
        if not isinstance(value, dict):
            return
        url = value.get("url")
        if isinstance(url, str) and re.match(r"^https?://", url):
            if url not in seen:
                seen.add(url)
                quality = _quality(url, value.get("quality"))
                stream = {
                    "name": "CinemaBox",
                    "title": "CinemaBox " + quality,
                    "url": url,
                    "behaviorHints": {
                        "notWebReady": False,
                        "proxyHeaders": {
                            "request": {
                                "User-Agent": USER_AGENT,
                                "Referer": BASE_URL,
                            }
                        },
                    },
                }
                if subtitles:
                    stream["subtitles"] = [
                        {
                            "url": sub["url"],
                            "lang": sub.get("lang", "ar"),
                            "language": sub.get("language", "ar"),
                            "label": sub.get("title", "Arabic"),
                        }
                        for sub in subtitles
                    ]
                streams.append(stream)
        if value.get("videos"):
            walk(value["videos"])

    walk(data)
    return streams


def _episode_files(episode_id, episode_number):
    data = _request(
        BASE_URL + "shows/episodes/" + urllib.parse.quote(str(episode_id)) + "/files"
    )
    if not data:
        return []
    target = data
    episodes = data.get("episodes") if isinstance(data, dict) else None
    if isinstance(episodes, list):
        for episode in episodes:
            if _episode_number(episode) == episode_number:
                target = episode
                break
    return _streams_from_data(target)


def _search(term):
    encoded = urllib.parse.quote(term)
    paths = (
        "shows/search?q=",
        "search?q=",
        "search?query=",
        "search?term=",
        "search?search_term=",
    )
    results = []
    for path in paths:
        results.extend(_arr(_request(BASE_URL + path + encoded)))
    return results


def _series_streams(tmdb_id, season, episode):
    titles = _tmdb_tv_titles(tmdb_id)
    if not titles:
        return []

    for title in titles:
        results = _search(title)
        for result in results:
            show_id = _id(result)
            if not show_id or not _matches(result, titles):
                continue
            data = _dynamic(show_id)
            seasons = _find_seasons(data)
            for season_number, season_id in seasons:
                if season_number != season:
                    continue
                season_data = _dynamic(show_id, season_id)
                episodes = _find_episodes(season_data)
                for episode_number, episode_id in episodes:
                    if episode_number == episode:
                        streams = _episode_files(episode_id, episode)
                        if streams:
                            return streams
    return []


def get_streams(media_type, media_id, config=None):
    """Return CinemaBox streams for a MegaSource request."""
    try:
        if media_type != "series":
            # The existing CinemaBox JS provider in test2 implements the
            # TV/series path. Keep movie requests empty rather than guessing
            # an undocumented CinemaBox movie endpoint.
            return []

        parts = str(media_id).split(":")
        if len(parts) != 3:
            return []

        imdb_id = parts[0]
        season = int(parts[1])
        episode = int(parts[2])
        tmdb = _imdb_to_tmdb(imdb_id)
        if not tmdb or tmdb.get("type") != "tv" or not tmdb.get("id"):
            return []

        return _series_streams(tmdb["id"], season, episode)
    except (TypeError, ValueError, KeyError, IndexError):
        return []
