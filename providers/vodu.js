// VODU Provider — Iraq Scrapers v4.1.0
// Standalone — no require() needed

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
  return { url: url, language: lang || "ar", label: label || "عربي", format: format };
}

function extractSubtitles(html) {
  var subs = [], seen = {};
  var trackRe = /<track[^>]+kind=["'](?:subtitles|captions)["'][^>]*>/gi;
  var m;
  while ((m = trackRe.exec(html)) !== null) {
    var tag = m[0];
    var srcM = /src=["']([^"']+)["']/.exec(tag);
    var langM = /srclang=["']([^"']+)["']/.exec(tag);
    var labelM = /label=["']([^"']+)["']/.exec(tag);
    if (srcM && srcM[1] && !seen[srcM[1]]) {
      seen[srcM[1]] = true;
      var sub = makeSubtitle(srcM[1], (langM && langM[1]) || "ar", (labelM && labelM[1]) || "عربي");
      if (sub) subs.push(sub);
    }
  }
  if (subs.length === 0) {
    var fbRe = /(https?:\/\/[^"'\s<>]+\.(?:vtt|srt))(?:\?[^"'\s<>]*)?/gi;
    var fbM;
    while ((fbM = fbRe.exec(html)) !== null) {
      if (!seen[fbM[1]] && !/thumb|poster|preview/i.test(fbM[1])) {
        seen[fbM[1]] = true;
        subs.push(makeSubtitle(fbM[1], "ar", "عربي"));
      }
    }
  }
  return subs;
}

function getAllVideoUrls(html) {
  var urls = [], m;
  var patterns = [
    /["'](https?:\/\/[^"'\s]*:8888\/[^"'\s]+\.(?:mp4|m3u8)[^"'\s]*)/gi,
    /<(?:source|video)[^>]*src=["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)/gi,
    /(?:file|src|url|videoUrl|source)\s*[:=]\s*["'](https?:\/\/[^"'\s]+\.(?:mp4|m3u8)[^"'\s]*)/gi,
    /["'](https?:\/\/[^"'\s]+\.(?:mp4|m3u8)(?:\?[^"'\s]*)?)/gi
  ];
  for (var p = 0; p < patterns.length; p++) {
    while ((m = patterns[p].exec(html)) !== null) {
      var u = m[1].replace(/\\\//g, "/").replace(/&amp;/g, "&");
      if (urls.indexOf(u) === -1) urls.push(u);
    }
  }
  return urls;
}

function isSkip(url) {
  return (/-t\.(mp4|m3u8)/i.test(url) || /_t\.(mp4|m3u8)/i.test(url) || /thumb|trailer|preview|poster/i.test(url));
}

function getQ(url) {
  if (/-1080\./i.test(url)) return "1080p";
  if (/-720\./i.test(url))  return "720p";
  if (/-480\./i.test(url))  return "480p";
  if (/-360\./i.test(url))  return "360p";
  if (/\.m3u8/i.test(url))  return "HLS";
  return "HD";
}

// ── Main ───────────────────────────────────────────────────────

function getStreams(tmdbId, mediaType, season, episode) {
  return fetchTMDBTitles(tmdbId, mediaType)
    .then(function (titles) {
      if (titles.length === 0) return [];
      return searchVODU(titles, 0, mediaType, season, episode);
    })
    .catch(function () { return []; });
}

function searchVODU(titles, idx, mediaType, season, episode) {
  if (idx >= titles.length) return Promise.resolve([]);
  return fetchWithTimeout("https://movie.vodu.me/index.php?do=list&title=" + encodeURIComponent(titles[idx]))
    .then(function (r) { return r.text(); })
    .then(function (html) {
      var links = [];
      var re = /href=["']([^"']*do=view[^"']*)["']/gi;
      var m;
      while ((m = re.exec(html)) !== null) {
        var href = m[1].replace(/&amp;/g, "&");
        if (href.indexOf("http") !== 0) href = "https://movie.vodu.me/" + href.replace(/^\//, "");
        if (links.indexOf(href) === -1) links.push(href);
      }
      if (links.length === 0) return searchVODU(titles, idx + 1, mediaType, season, episode);
      return tryLinks(links, 0, mediaType, season, episode);
    })
    .catch(function () { return searchVODU(titles, idx + 1, mediaType, season, episode); });
}

function tryLinks(links, idx, mediaType, season, episode) {
  if (idx >= links.length) return Promise.resolve([]);
  return fetchWithTimeout(links[idx])
    .then(function (r) { return r.text(); })
    .then(function (html) {
      var allUrls = getAllVideoUrls(html);
      var subtitles = extractSubtitles(html);
      var streams;
      if ((mediaType === "tv" || mediaType === "series") && season && episode) {
        streams = filterEpisode(allUrls, parseInt(season) || 1, parseInt(episode) || 1, subtitles);
      } else {
        streams = filterMovie(allUrls, subtitles);
      }
      if (streams.length > 0) return streams;
      return tryLinks(links, idx + 1, mediaType, season, episode);
    })
    .catch(function () { return tryLinks(links, idx + 1, mediaType, season, episode); });
}

function filterEpisode(allUrls, sNum, eNum, subtitles) {
  var sStr = sNum < 10 ? "0" + sNum : "" + sNum;
  var eStr = eNum < 10 ? "0" + eNum : "" + eNum;
  var pats = ["S" + sStr + "E" + eStr, "s" + sStr + "e" + eStr, "S" + sNum + "E" + eNum];
  var streams = [], seen = {};
  for (var i = 0; i < allUrls.length; i++) {
    var url = allUrls[i];
    if (isSkip(url)) continue;
    var upper = url.toUpperCase();
    for (var p = 0; p < pats.length; p++) {
      if (upper.indexOf(pats[p].toUpperCase()) > -1 && !seen[url]) {
        seen[url] = true;
        streams.push({ name: "VODU", title: "VODU " + getQ(url), url: url, quality: getQ(url), subtitles: subtitles });
        break;
      }
    }
  }
  return sortByQuality(streams);
}

function filterMovie(allUrls, subtitles) {
  var streams = [], seen = {};
  for (var i = 0; i < allUrls.length; i++) {
    var url = allUrls[i];
    if (isSkip(url) || seen[url]) continue;
    seen[url] = true;
    streams.push({ name: "VODU", title: "VODU " + getQ(url), url: url, quality: getQ(url), subtitles: subtitles });
  }
  return sortByQuality(streams);
}
