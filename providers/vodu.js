function getStreams(tmdbId, mediaType, season, episode) {
  var path = "/" + (mediaType === "movie" ? "movie" : "tv") + "/" + tmdbId;
  var url = "https://api.themoviedb.org/3" + path + "?api_key=" + TMDB_API_KEY + "&language=en";

  return fetch(url)
    .then(function(r) { return r.json(); })
    .then(function(info) {
      var titles = [];
      if (info.title) titles.push(info.title);
      if (info.original_title && titles.indexOf(info.original_title) === -1) titles.push(info.original_title);
      if (info.name) titles.push(info.name);
      if (info.original_name && titles.indexOf(info.original_name) === -1) titles.push(info.original_name);
      if (titles.length === 0) return [];
      return searchVODU(titles, 0, mediaType, season, episode);
    })
    .catch(function() { return []; });
}

function searchVODU(titles, idx, mediaType, season, episode) {
  if (idx >= titles.length) return [];
  return fetch("https://movie.vodu.me/index.php?do=list&title=" + encodeURIComponent(titles[idx]))
    .then(function(r) { return r.text(); })
    .then(function(html) {
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
    .catch(function() { return searchVODU(titles, idx + 1, mediaType, season, episode); });
}

function tryLinks(links, idx, mediaType, season, episode) {
  if (idx >= links.length) return [];
  return fetch(links[idx])
    .then(function(r) { return r.text(); })
    .then(function(html) {
      var allUrls = getAllVideoUrls(html);
      var s;
      if (mediaType === "tv" && season && episode) {
        s = filterEpisode(allUrls, parseInt(season) || 1, parseInt(episode) || 1, html);
      } else {
        s = filterMovieUrls(allUrls, html);
      }
      if (s.length > 0) return s;
      return tryLinks(links, idx + 1, mediaType, season, episode);
    })
    .catch(function() { return tryLinks(links, idx + 1, mediaType, season, episode); });
}

function filterEpisode(allUrls, sNum, eNum, html) {
  var sStr = sNum < 10 ? "0" + sNum : "" + sNum;
  var eStr = eNum < 10 ? "0" + eNum : "" + eNum;
  var pats = [
    "S" + sStr + "E" + eStr,
    "s" + sStr + "e" + eStr,
    "S" + sNum + "E" + eNum,
    "s" + sNum + "e" + eNum
  ];
  var streams = [];
  var seen = {};
  for (var i = 0; i < allUrls.length; i++) {
    var url = allUrls[i];
    if (isSkip(url)) continue;
    var upper = url.toUpperCase();
    var matched = false;
    for (var p = 0; p < pats.length; p++) {
      if (upper.indexOf(pats[p].toUpperCase()) > -1) {
        matched = true;
        break;
      }
    }
    if (matched && !seen[url]) {
      seen[url] = true;
      streams.push({ name: "VODU", title: "VODU " + getQ(url), url: url, quality: getQ(url) });
    }
  }
  if (streams.length === 0) {
    var epPats = [
      "_E" + eStr + "_", "_E" + eStr + "-", "_E" + eStr + ".",
      "_E" + eNum + "_", "_E" + eNum + "-", "_E" + eNum + ".",
      "E" + eStr + "_", "E" + eStr + "-",
      "_" + eStr + "_"
    ];
    for (var i2 = 0; i2 < allUrls.length; i2++) {
      var url2 = allUrls[i2];
      if (isSkip(url2)) continue;
      var upper2 = url2.toUpperCase();
      for (var p2 = 0; p2 < epPats.length; p2++) {
        if (upper2.indexOf(epPats[p2].toUpperCase()) > -1 && !seen[url2]) {
          seen[url2] = true;
          streams.push({ name: "VODU", title: "VODU " + getQ(url2), url: url2, quality: getQ(url2) });
          break;
        }
      }
    }
  }
  addVariants(streams, html);
  sortStreams(streams);
  return streams;
}

function filterMovieUrls(allUrls, html) {
  var streams = [];
  var seen = {};
  for (var i = 0; i < allUrls.length; i++) {
    var url = allUrls[i];
    if (isSkip(url)) continue;
    if (seen[url]) continue;
    seen[url] = true;
    streams.push({ name: "VODU", title: "VODU " + getQ(url), url: url, quality: getQ(url) });
  }
  addVariants(streams, html);
  sortStreams(streams);
  return streams;
}

function getAllVideoUrls(html) {
  var urls = [];
  var m;
  var res = [
    /["'](https?:\/\/[^"'\s]*:8888\/[^"'\s]+\.(?:mp4|m3u8)[^"'\s]*)/gi,
    /<(?:source|video)[^>]*src=["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)/gi,
    /(?:file|src|url|videoUrl|source)\s*[:=]\s*["'](https?:\/\/[^"'\s]+\.(?:mp4|m3u8)[^"'\s]*)/gi,
    /"(https?:\\\/\\\/[^"]*\.(?:mp4|m3u8)[^"]*)"/g,
    /["'](https?:\/\/[^"'\s]+\.(?:mp4|m3u8)(?:\?[^"'\s]*)?)/gi
  ];
  for (var p = 0; p < res.length; p++) {
    while ((m = res[p].exec(html)) !== null) {
      var u = m[1].replace(/\\\//g, "/").replace(/&amp;/g, "&");
      if (urls.indexOf(u) === -1) urls.push(u);
    }
  }
  return urls;
}

function isSkip(url) {
  if (/-t\.(mp4|m3u8)/i.test(url)) return true;
  if (/_t\.(mp4|m3u8)/i.test(url)) return true;
  if (/thumb|trailer|preview|poster/i.test(url)) return true;
  return false;
}

function getQ(url) {
  if (/-360\./i.test(url)) return "360p";
  if (/-480\./i.test(url)) return "480p";
  if (/-720\./i.test(url)) return "720p";
  if (/-1080\./i.test(url)) return "1080p";
  if (/\.m3u8/i.test(url)) return "HLS";
  return "HD";
}

function addVariants(streams, html) {
  var has720 = false;
  var baseUrl = null;
  for (var i = 0; i < streams.length; i++) {
    if (streams[i].quality === "720p") has720 = true;
    if (!baseUrl && /-(?:360|1080)\./i.test(streams[i].url)) baseUrl = streams[i].url;
  }
  if (!has720 && baseUrl && html.indexOf("720") > -1) {
    var u = baseUrl.replace(/-(?:360|1080)\./i, "-720.");
    streams.push({ name: "VODU", title: "VODU 720p", url: u, quality: "720p" });
  }
}

function sortStreams(streams) {
  var order = {"1080p": 0, "720p": 1, "480p": 2, "360p": 3, "HLS": 4, "HD": 5};
  streams.sort(function(a, b) {
    return (order[a.quality] != null ? order[a.quality] : 9) - (order[b.quality] != null ? order[b.quality] : 9);
  });
}

module.exports = { getStreams: getStreams };
