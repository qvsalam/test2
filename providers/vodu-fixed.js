// VODU Provider — Iraq Scrapers v5.0.0

var TMDB_KEY = "ee8ac8a9044c09a11cc362033f98c735";
var QUALITY_ORDER = { "1080p": 0, "720p": 1, "480p": 2, "360p": 3, "240p": 4, "HLS": 5, "HD": 6 };

function sortByQuality(streams) {
  return streams.sort(function(a, b) {
    var oa = QUALITY_ORDER[a.quality] != null ? QUALITY_ORDER[a.quality] : 99;
    var ob = QUALITY_ORDER[b.quality] != null ? QUALITY_ORDER[b.quality] : 99;
    return oa - ob;
  });
}

function fetchTMDBTitles(tmdbId, mediaType) {
  var path = "/" + (mediaType === "movie" ? "movie" : "tv") + "/" + tmdbId;
  var base = "https://api.themoviedb.org/3" + path + "?api_key=" + TMDB_KEY;
  return Promise.all([
    fetch(base + "&language=en").then(function(r) { return r.json(); }).catch(function() { return {}; }),
    fetch(base + "&language=ar").then(function(r) { return r.json(); }).catch(function() { return {}; })
  ]).then(function(res) {
    var en = res[0], ar = res[1];
    var titles = [];
    function add(t) { if (t && titles.indexOf(t) === -1) titles.push(t); }
    add(en.title); add(en.original_title); add(en.name); add(en.original_name);
    add(ar.title); add(ar.original_title); add(ar.name); add(ar.original_name);
    return titles.filter(Boolean);
  });
}

function clean(s) {
  return String(s || "").replace(/\\\//g, "/").replace(/&amp;/g, "&").replace(/\\u0026/g, "&");
}

function getQ(url) {
  var u = clean(url).split("?")[0].toLowerCase();
  if (/-t\.(mp4|m3u8)$/i.test(u)) return "720p";
  if (/1080p|(^|[^0-9])1080([^0-9]|$)/i.test(u)) return "1080p";
  if (/720p|(^|[^0-9])720([^0-9]|$)/i.test(u)) return "720p";
  if (/480p|(^|[^0-9])480([^0-9]|$)/i.test(u)) return "480p";
  if (/360p|(^|[^0-9])360([^0-9]|$)/i.test(u)) return "360p";
  if (/240p|(^|[^0-9])240([^0-9]|$)/i.test(u)) return "240p";
  if (/\.m3u8$/i.test(u)) return "HLS";
  return "HD";
}

function isSkip(url) {
  return /_t\.(mp4|m3u8)|thumb|trailer|preview|poster|sprite|thumbnail/i.test(url);
}

function getAllVideoUrls(html) {
  html = clean(html);
  var urls = [], m;
  var patterns = [
    /["'](https?:\/\/[^"'\s]*:8888\/[^"'\s]+\.(?:mp4|m3u8)(?:\?[^"'\s]*)?)/gi,
    /<(?:source|video)[^>]*src=["'](https?:\/\/[^"']+\.(?:mp4|m3u8)(?:\?[^"']*)?)/gi,
    /(?:file|src|url|videoUrl|source)\s*[:=]\s*["'](https?:\/\/[^"'\s]+\.(?:mp4|m3u8)(?:\?[^"'\s]*)?)/gi,
    /["'](https?:\/\/[^"'\s]+\.(?:mp4|m3u8)(?:\?[^"'\s]*)?)/gi
  ];
  for (var p = 0; p < patterns.length; p++) {
    while ((m = patterns[p].exec(html)) !== null) {
      var u = clean(m[1]);
      if (!isSkip(u) && urls.indexOf(u) === -1) urls.push(u);
    }
  }
  return urls;
}

function getStreams(tmdbId, mediaType, season, episode) {
  return fetchTMDBTitles(tmdbId, mediaType)
    .then(function(titles) {
      if (!titles.length) return [];
      return searchVODU(titles, 0, mediaType, season, episode);
    })
    .catch(function() { return []; });
}

function searchVODU(titles, idx, mediaType, season, episode) {
  if (idx >= titles.length) return Promise.resolve([]);
  return fetch("https://movie.vodu.me/index.php?do=list&title=" + encodeURIComponent(titles[idx]))
    .then(function(r) { return r.text(); })
    .then(function(html) {
      var links = [], m;
      var re = /href=["']([^"']*do=view[^"']*)["']/gi;
      while ((m = re.exec(html)) !== null) {
        var href = clean(m[1]);
        if (href.indexOf("http") !== 0) href = "https://movie.vodu.me/" + href.replace(/^\//, "");
        if (links.indexOf(href) === -1) links.push(href);
      }
      if (!links.length) return searchVODU(titles, idx + 1, mediaType, season, episode);
      return tryLinks(links, 0, mediaType, season, episode);
    })
    .catch(function() { return searchVODU(titles, idx + 1, mediaType, season, episode); });
}

function tryLinks(links, idx, mediaType, season, episode) {
  if (idx >= links.length) return Promise.resolve([]);
  return fetch(links[idx])
    .then(function(r) { return r.text(); })
    .then(function(html) {
      var allUrls = getAllVideoUrls(html);
      var streams = ((mediaType === "tv" || mediaType === "series") && season && episode)
        ? filterEpisode(allUrls, parseInt(season) || 1, parseInt(episode) || 1)
        : filterMovie(allUrls);
      if (streams.length) return streams;
      return tryLinks(links, idx + 1, mediaType, season, episode);
    })
    .catch(function() { return tryLinks(links, idx + 1, mediaType, season, episode); });
}

function makeStream(url) {
  var q = getQ(url);
  return { title: "VODU " + q, name: "VODU", provider: "VODU", url: url, quality: q, type: url.indexOf(".m3u8") > -1 ? "hls" : "direct" };
}

function filterEpisode(allUrls, sNum, eNum) {
  var sStr = sNum < 10 ? "0" + sNum : "" + sNum;
  var eStr = eNum < 10 ? "0" + eNum : "" + eNum;
  var pats = ["S" + sStr + "E" + eStr, "s" + sStr + "e" + eStr, "S" + sNum + "E" + eNum];
  var streams = [], seen = {};
  for (var i = 0; i < allUrls.length; i++) {
    var url = allUrls[i];
    var upper = url.toUpperCase();
    for (var p = 0; p < pats.length; p++) {
      if (upper.indexOf(pats[p].toUpperCase()) > -1 && !seen[url]) {
        seen[url] = true;
        streams.push(makeStream(url));
        break;
      }
    }
  }
  return sortByQuality(streams);
}

function filterMovie(allUrls) {
  var streams = [], seen = {};
  for (var i = 0; i < allUrls.length; i++) {
    var url = allUrls[i];
    if (!url || seen[url]) continue;
    seen[url] = true;
    streams.push(makeStream(url));
  }
  return sortByQuality(streams);
}

module.exports = { getStreams: getStreams };
