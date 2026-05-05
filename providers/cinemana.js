// Cinemana Provider — Iraq Scrapers v4.1.0
// Standalone — no require() needed

var API = "https://cinemana.shabakaty.com/api/android/";

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
  var raw = Array.isArray(data) ? data : (data.subtitles || data.tracks || []);
  for (var i = 0; i < raw.length; i++) {
    var s = raw[i];
    var url = s.url || s.subtitleUrl || s.file || s.link || "";
    var lang = s.language || s.lang || s.languageCode || "ar";
    var label = s.label || s.languageName || s.name || (lang === "ar" ? "عربي" : lang);
    if (url && !seen[url]) {
      seen[url] = true;
      var sub = makeSubtitle(url, lang, label);
      if (sub) subs.push(sub);
    }
  }
  return subs;
}

// ── Main ───────────────────────────────────────────────────────

function getStreams(tmdbId, mediaType, season, episode) {
  return fetchTMDBTitles(tmdbId, mediaType)
    .then(function (titles) {
      if (titles.length === 0) return [];
      var type = mediaType === "movie" ? "movies" : "series";
      return searchCinemana(titles, 0, type, season, episode);
    })
    .catch(function () { return []; });
}

function searchCinemana(titles, idx, type, season, episode) {
  if (idx >= titles.length) return Promise.resolve([]);
  return fetchWithTimeout(API + "AdvancedSearch?videoTitle=" + encodeURIComponent(titles[idx]) + "&type=" + type)
    .then(function (r) { return r.json(); })
    .then(function (results) {
      if (!results || results.length === 0)
        return searchCinemana(titles, idx + 1, type, season, episode);
      var nb = results[0].nb;
      if (type === "series" && season && episode)
        return getTVFiles(nb, parseInt(season) || 1, parseInt(episode) || 1);
      return getFiles(nb);
    })
    .catch(function () { return searchCinemana(titles, idx + 1, type, season, episode); });
}

function getTVFiles(showNb, sNum, eNum) {
  return fetchWithTimeout(API + "videoSeason/id/" + showNb)
    .then(function (r) { return r.json(); })
    .then(function (seasons) {
      if (!seasons || seasons.length === 0) return [];
      var seasonData = null;
      for (var i = 0; i < seasons.length; i++) {
        var s = seasons[i];
        var sn = parseInt(s.season) || parseInt(s.seasonNumber) || (i + 1);
        if (sn === sNum) { seasonData = s; break; }
      }
      if (!seasonData && seasons.length >= sNum) seasonData = seasons[sNum - 1];
      if (!seasonData) return [];
      var episodes = seasonData.episodes || [];
      if (episodes.length === 0) return [];
      var epNb = null;
      for (var j = 0; j < episodes.length; j++) {
        var ep = episodes[j];
        var en = parseInt(ep.episodeNummer) || parseInt(ep.episodeNumber) || (j + 1);
        if (en === eNum) { epNb = ep.nb; break; }
      }
      if (!epNb && episodes.length >= eNum) epNb = episodes[eNum - 1].nb;
      if (!epNb) return [];
      return getFiles(epNb);
    })
    .catch(function () { return []; });
}

function getFiles(nb) {
  return fetchWithTimeout(API + "transcoddedFiles/id/" + nb)
    .then(function (r) { return r.json(); })
    .then(function (files) {
      return fetchWithTimeout(API + "videoSubtitles/id/" + nb)
        .then(function (r2) { return r2.json(); })
        .catch(function () { return []; })
        .then(function (subsData) {
          var subtitles = extractSubtitles(subsData);
          var streams = [], seen = {};
          for (var i = 0; i < files.length; i++) {
            var f = files[i];
            var url = f.videoUrl || f.url || f.transcoddedFile || "";
            var q = normalizeQuality(f.resolution || f.quality || "HD");
            if (url && !seen[url]) {
              seen[url] = true;
              streams.push({ name: "Cinemana", title: "Cinemana " + q, url: url, quality: q, subtitles: subtitles });
            }
          }
          return sortByQuality(streams);
        });
    })
    .catch(function () { return []; });
}
