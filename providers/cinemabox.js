// CinemaBox Provider — Iraq Scrapers v4.1.0
// Standalone — no require() needed

var API = "https://cinema.albox.co/api/v4/";

var QUALITY_ORDER = { "1080p": 0, "720p": 1, "480p": 2, "360p": 3, "HLS": 4, "HD": 5 };

function fetchWithTimeout(url, ms) {
  ms = ms || 8000;
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, ms);
  return fetch(url, { signal: controller.signal })
    .then(function (r) { clearTimeout(timer); return r; })
    .catch(function (e) { clearTimeout(timer); throw e; });
}

function fetchTMDBTitles(tmdbId, mediaType) {
  var path = "/" + (mediaType === "movie" ? "movie" : "tv") + "/" + tmdbId;
  var base = "https://api.themoviedb.org/3" + path + "?api_key=" + TMDB_API_KEY;
  return Promise.all([
    fetch(base + "&language=en").then(function (r) { return r.json(); }).catch(function () { return {}; }),
    fetch(base + "&language=ar").then(function (r) { return r.json(); }).catch(function () { return {}; })
  ]).then(function (res) {
    var en = res[0], ar = res[1];
    var titles = [];
    function add(t) { if (t && titles.indexOf(t) === -1) titles.push(t); }
    add(en.title); add(en.original_title); add(en.name); add(en.original_name);
    add(ar.title); add(ar.name);
    return titles.filter(Boolean);
  });
}

function normalizeQuality(q) {
  if (!q) return "HD";
  if (typeof q === "number") return q + "p";
  return String(q).replace(/\s/g, "");
}

function sortByQuality(streams) {
  return streams.sort(function (a, b) {
    var oa = QUALITY_ORDER[a.quality] != null ? QUALITY_ORDER[a.quality] : 9;
    var ob = QUALITY_ORDER[b.quality] != null ? QUALITY_ORDER[b.quality] : 9;
    return oa - ob;
  });
}

function makeSubtitle(url, lang, label) {
  if (!url) return null;
  var format = "vtt";
  if (/\.srt(\?|$)/i.test(url)) format = "srt";
  if (/\.ass(\?|$)/i.test(url)) format = "ass";
  return { url: url, language: lang || "ar", label: label || "عربي", format: format };
}

function extractSubtitles(data) {
  var subs = [], seen = {};
  var raw = data.subtitles || data.tracks || data.captions || [];
  for (var i = 0; i < raw.length; i++) {
    var s = raw[i];
    var url = s.url || s.file || s.src || "";
    var lang = s.language || s.lang || "ar";
    var label = s.label || s.name || (lang === "ar" ? "عربي" : lang);
    if (url && !seen[url]) {
      seen[url] = true;
      var sub = makeSubtitle(url, lang, label);
      if (sub) subs.push(sub);
    }
  }
  if (subs.length === 0) {
    var text = JSON.stringify(data);
    var re = /(https?:\/\/[^"'\s]+\.(?:vtt|srt|ass))(?:\?[^"'\s]*)?/gi;
    var m;
    while ((m = re.exec(text)) !== null) {
      if (!seen[m[0]]) { seen[m[0]] = true; subs.push(makeSubtitle(m[0], "ar", "عربي")); }
    }
  }
  return subs;
}

// ── Main ───────────────────────────────────────────────────────

function getStreams(tmdbId, mediaType, season, episode) {
  return fetchTMDBTitles(tmdbId, mediaType)
    .then(function (titles) {
      if (titles.length === 0) return [];
      return searchCB(titles, 0, mediaType, season, episode);
    })
    .catch(function () { return []; });
}

function searchCB(titles, idx, mediaType, season, episode) {
  if (idx >= titles.length) return Promise.resolve([]);
  return fetchWithTimeout(API + "search?q=" + encodeURIComponent(titles[idx]))
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data.results || data.results.length === 0)
        return searchCB(titles, idx + 1, mediaType, season, episode);

      var targetType = mediaType === "movie" ? "MOVIE" : "SERIES";
      var match = null;
      for (var i = 0; i < data.results.length; i++) {
        if (data.results[i].type === targetType) { match = data.results[i]; break; }
      }
      if (!match) match = data.results[0];

      return fetchWithTimeout(API + "shows/shows/dynamic/" + match.id)
        .then(function (r2) { return r2.json(); })
        .then(function (detail) {
          if (!detail.post_info) return searchCB(titles, idx + 1, mediaType, season, episode);
          if (mediaType === "movie") {
            var epId = detail.post_info.episode_id;
            if (!epId) return Promise.resolve([]);
            return getPlayerStreams(epId);
          } else {
            return getTVStreams(detail, parseInt(season) || 1, parseInt(episode) || 1);
          }
        });
    })
    .catch(function () { return searchCB(titles, idx + 1, mediaType, season, episode); });
}

function getTVStreams(detail, sNum, eNum) {
  var sections = detail.sections || [];
  var seasonEpisodes = null;

  for (var i = 0; i < sections.length; i++) {
    var sec = sections[i];
    var data = sec.data || [];
    if (data.length === 0 || data[0].card_type !== "episode") continue;
    var secTitle = (sec.title || sec.name || "").toLowerCase();
    var secNum = parseInt(sec.season_number || sec.seasonNumber || sec.number || 0);
    if (secNum === sNum) { seasonEpisodes = data; break; }
    if (secTitle.indexOf("season " + sNum) > -1 || secTitle.indexOf("الموسم " + sNum) > -1) { seasonEpisodes = data; break; }
    if (secNum === 0 && !seasonEpisodes) seasonEpisodes = data;
  }

  if (!seasonEpisodes || seasonEpisodes.length === 0) {
    var epId = detail.post_info && detail.post_info.episode_id;
    return epId ? getPlayerStreams(epId) : Promise.resolve([]);
  }

  var ep = null;
  for (var j = 0; j < seasonEpisodes.length; j++) {
    var e = seasonEpisodes[j];
    var en = parseInt(e.episode_number || e.episodeNumber || e.number || (j + 1));
    if (en === eNum) { ep = e; break; }
  }
  if (!ep && seasonEpisodes.length >= eNum) ep = seasonEpisodes[eNum - 1];
  if (!ep) return Promise.resolve([]);
  return getPlayerStreams(ep.id);
}

function getPlayerStreams(episodeId) {
  return fetchWithTimeout(API + "shows/episodes/player/" + episodeId)
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var streams = [], seen = {};
      var subtitles = extractSubtitles(data);
      var videos = data.videos || [];
      for (var i = 0; i < videos.length; i++) {
        var v = videos[i];
        if (!v.url || seen[v.url]) continue;
        seen[v.url] = true;
        var q = normalizeQuality(v.quality || "HD");
        streams.push({ name: "CinemaBox", title: "CinemaBox " + q, url: v.url, quality: q, subtitles: subtitles });
      }
      if (streams.length === 0) {
        var text = JSON.stringify(data);
        var re = /(https?:\/\/cloud[0-9]*\.albox\.co\/episodes\/[^"'\s,\]]+\.mp4)/gi;
        var m;
        while ((m = re.exec(text)) !== null) {
          if (!seen[m[1]]) {
            seen[m[1]] = true;
            streams.push({ name: "CinemaBox", title: "CinemaBox HD", url: m[1], quality: "HD", subtitles: subtitles });
          }
        }
      }
      return sortByQuality(streams);
    })
    .catch(function () { return []; });
}
