// VODU Provider — Iraq Scrapers v4.8.0

var TMDB_KEY = "ee8ac8a9044c09a11cc362033f98c735";
var QUALITY_ORDER = { "1080p": 0, "720p": 1, "480p": 2, "360p": 3, "240p": 4, "HLS": 5, "HD": 6 };

function sortByQuality(streams) {
  return streams.sort(function(a, b) {
    var oa = QUALITY_ORDER[a.quality] != null ? QUALITY_ORDER[a.quality] : 99;
    var ob = QUALITY_ORDER[b.quality] != null ? QUALITY_ORDER[b.quality] : 99;
    return oa - ob;
  });
}

function normalizeVoduQuality(q) {
  q = String(q || "HD");
  if (q === "4K" || q === "2160p") return "1080p";
  return q;
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

function cleanText(s) {
  return String(s || "")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&")
    .replace(/\\u0026/g, "&");
}

function qualityRank(q) {
  q = normalizeVoduQuality(q);
  return QUALITY_ORDER[q] != null ? QUALITY_ORDER[q] : 99;
}

function strictQuality(text) {
  text = cleanText(text).toLowerCase();
  if (/(^|[^0-9])1080p?([^0-9]|$)/i.test(text)) return "1080p";
  if (/(^|[^0-9])720p?([^0-9]|$)/i.test(text)) return "720p";
  if (/(^|[^0-9])480p?([^0-9]|$)/i.test(text)) return "480p";
  if (/(^|[^0-9])360p?([^0-9]|$)/i.test(text)) return "360p";
  if (/(^|[^0-9])240p?([^0-9]|$)/i.test(text)) return "240p";
  return null;
}

function looseQualityFromUrl(url) {
  url = cleanText(url).toLowerCase();
  if (/[_\-/=.](1080|fhd)([_\-/=.\?&]|$)|1080p/i.test(url)) return "1080p";
  if (/[_\-/=.](720)([_\-/=.\?&]|$)|720p/i.test(url)) return "720p";
  if (/[_\-/=.](480)([_\-/=.\?&]|$)|480p/i.test(url)) return "480p";
  if (/[_\-/=.](360)([_\-/=.\?&]|$)|360p/i.test(url)) return "360p";
  if (/[_\-/=.](240)([_\-/=.\?&]|$)|240p/i.test(url)) return "240p";
  return null;
}

function qualityFromContext(context) {
  context = cleanText(context);

  var labelRe = /(?:quality|resolution|res|label|data-quality|data-res|data-label)[^0-9a-z]{0,30}(1080|720|480|360|240)p?/i;
  var m = labelRe.exec(context);
  if (m) return m[1] + "p";

  var visibleRe = /(?:>|\s|["'])(1080p|720p|480p|360p|240p)(?:<|\s|["'])/i;
  m = visibleRe.exec(context);
  if (m) return m[1].replace("P", "p");

  return null;
}

function getQ(url, hint) {
  var fromHint = qualityFromContext(hint || "");
  if (fromHint) return normalizeVoduQuality(fromHint);

  var cleanUrl = cleanText(url).split("?")[0];
  var fromUrl = strictQuality(cleanUrl) || looseQualityFromUrl(cleanUrl);
  if (fromUrl) return normalizeVoduQuality(fromUrl);

  if (/\.m3u8/i.test(url)) return "HLS";
  return "HD";
}

function isSkip(url) {
  return (/-t\.(mp4|m3u8)/i.test(url) ||
          /_t\.(mp4|m3u8)/i.test(url) ||
          /thumb|trailer|preview|poster|sprite|thumbnail/i.test(url));
}

function addVideo(out, seen, url, hint) {
  url = cleanText(url);
  if (!url || isSkip(url)) return;
  var q = normalizeVoduQuality(getQ(url, hint || ""));
  var key = url;
  if (seen[key] != null) {
    var old = out[seen[key]];
    if (qualityRank(q) < qualityRank(old.quality)) old.quality = q;
    return;
  }
  seen[key] = out.length;
  out.push({ url: url, quality: q });
}

function getAllVideoUrls(html) {
  html = cleanText(html);
  var out = [], seen = {}, m, p;
  var patterns = [
    /["'](https?:\/\/[^"'\s]*:8888\/[^"'\s]+\.(?:mp4|m3u8)(?:\?[^"'\s]*)?)/gi,
    /<(?:source|video)[^>]*src=["'](https?:\/\/[^"']+\.(?:mp4|m3u8)(?:\?[^"']*)?)/gi,
    /(?:file|src|url|videoUrl|source)\s*[:=]\s*["'](https?:\/\/[^"'\s]+\.(?:mp4|m3u8)(?:\?[^"'\s]*)?)/gi,
    /["'](https?:\/\/[^"'\s]+\.(?:mp4|m3u8)(?:\?[^"'\s]*)?)/gi
  ];
  for (p = 0; p < patterns.length; p++) {
    while ((m = patterns[p].exec(html)) !== null) {
      var start = Math.max(0, m.index - 120);
      var end = Math.min(html.length, m.index + m[0].length + 120);
      addVideo(out, seen, m[1], html.substring(start, end));
    }
  }
  return out;
}

function absoluteUrl(base, child) {
  child = cleanText(child).trim();
  if (!child) return child;
  if (/^https?:\/\//i.test(child)) return child;
  var origin = base.match(/^(https?:\/\/[^\/]+)/i);
  if (child.charAt(0) === "/" && origin) return origin[1] + child;
  return base.substring(0, base.lastIndexOf("/") + 1) + child;
}

function qualityFromHeight(height) {
  height = parseInt(height, 10) || 0;
  if (height >= 1000) return "1080p";
  if (height >= 700) return "720p";
  if (height >= 470) return "480p";
  if (height >= 350) return "360p";
  if (height >= 200) return "240p";
  return "HLS";
}

function parseM3U8Variants(masterUrl, text) {
  var lines = cleanText(text).split(/\r?\n/);
  var variants = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (line.indexOf("#EXT-X-STREAM-INF") !== 0) continue;

    var next = "";
    for (var j = i + 1; j < lines.length; j++) {
      var candidate = lines[j].trim();
      if (candidate && candidate.charAt(0) !== "#") { next = candidate; break; }
    }
    if (!next) continue;

    var absolute = absoluteUrl(masterUrl, next);
    var q = null;
    var res = /RESOLUTION=\d+x(\d+)/i.exec(line);
    if (res) q = qualityFromHeight(res[1]);
    if (!q || q === "HLS") q = strictQuality(line) || looseQualityFromUrl(next) || looseQualityFromUrl(absolute) || "HLS";
    q = normalizeVoduQuality(q);

    variants.push({ url: absolute, quality: q });
  }
  return variants;
}

function expandHlsItem(item) {
  if (!/\.m3u8/i.test(item.url)) return Promise.resolve([item]);
  return fetch(item.url)
    .then(function(r) { return r.text(); })
    .then(function(text) {
      var variants = parseM3U8Variants(item.url, text);
      return variants.length ? variants : [item];
    })
    .catch(function() { return [item]; });
}

function expandItems(items) {
  return Promise.all(items.map(expandHlsItem)).then(function(groups) {
    var out = [], seen = {};
    for (var i = 0; i < groups.length; i++) {
      for (var j = 0; j < groups[i].length; j++) {
        var item = groups[i][j];
        if (!item.url || seen[item.url]) continue;
        seen[item.url] = true;
        item.quality = normalizeVoduQuality(item.quality);
        out.push(item);
      }
    }
    return out;
  });
}

function hasQuality(items, q) {
  for (var i = 0; i < items.length; i++) {
    if (normalizeVoduQuality(items[i].quality) === q) return true;
  }
  return false;
}

function pageMentions720(html) {
  return /(?:>|\s|["'])(720p|720)(?:<|\s|["'])/i.test(cleanText(html));
}

function uniquePush(arr, value) {
  if (value && arr.indexOf(value) === -1) arr.push(value);
}

function generate720Candidates(url) {
  var list = [];
  var u = cleanText(url);
  var patterns = [
    [/1080p/ig, "720p"],
    [/1080/ig, "720"],
    [/1920x1080/ig, "1280x720"],
    [/480p/ig, "720p"],
    [/480/ig, "720"],
    [/360p/ig, "720p"],
    [/360/ig, "720"]
  ];
  for (var i = 0; i < patterns.length; i++) {
    var candidate = u.replace(patterns[i][0], patterns[i][1]);
    if (candidate !== u) uniquePush(list, candidate);
  }
  return list;
}

function urlExists(url) {
  return fetch(url, { method: "HEAD" })
    .then(function(r) { return !!(r && r.ok); })
    .catch(function() {
      return fetch(url).then(function(r) { return !!(r && r.ok); }).catch(function() { return false; });
    });
}

function try720Candidates(items, candidates, index) {
  if (index >= candidates.length) return Promise.resolve(items);
  var c = candidates[index];
  for (var i = 0; i < items.length; i++) {
    if (items[i].url === c) return try720Candidates(items, candidates, index + 1);
  }
  return urlExists(c).then(function(ok) {
    if (ok) {
      items.push({ url: c, quality: "720p" });
      return items;
    }
    return try720Candidates(items, candidates, index + 1);
  });
}

function ensure720Variant(items, html) {
  if (hasQuality(items, "720p") || !pageMentions720(html)) return Promise.resolve(items);
  var candidates = [];
  for (var i = 0; i < items.length; i++) {
    var generated = generate720Candidates(items[i].url);
    for (var j = 0; j < generated.length; j++) uniquePush(candidates, generated[j]);
  }
  if (!candidates.length) return Promise.resolve(items);
  return try720Candidates(items, candidates, 0);
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
        var href = cleanText(m[1]);
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
      var selected;
      if ((mediaType === "tv" || mediaType === "series") && season && episode) {
        selected = selectEpisodeItems(allUrls, parseInt(season) || 1, parseInt(episode) || 1);
      } else {
        selected = selectMovieItems(allUrls);
      }
      return expandItems(selected).then(function(expanded) {
        return ensure720Variant(expanded, html);
      }).then(function(finalItems) {
        var streams = itemsToStreams(finalItems);
        if (streams.length) return streams;
        return tryLinks(links, idx + 1, mediaType, season, episode);
      });
    })
    .catch(function() { return tryLinks(links, idx + 1, mediaType, season, episode); });
}

function makeStream(url, quality) {
  quality = normalizeVoduQuality(quality || getQ(url, ""));
  return { title: "VODU " + quality, name: "VODU", provider: "VODU", url: url, quality: quality, type: url.indexOf(".m3u8") > -1 ? "hls" : "direct" };
}

function itemsToStreams(items) {
  var streams = [], seen = {};
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (!item.url || seen[item.url]) continue;
    seen[item.url] = true;
    streams.push(makeStream(item.url, item.quality));
  }
  return sortByQuality(streams);
}

function selectEpisodeItems(allUrls, sNum, eNum) {
  var sStr = sNum < 10 ? "0" + sNum : "" + sNum;
  var eStr = eNum < 10 ? "0" + eNum : "" + eNum;
  var pats = ["S" + sStr + "E" + eStr, "s" + sStr + "e" + eStr, "S" + sNum + "E" + eNum];
  var out = [], seen = {};
  for (var i = 0; i < allUrls.length; i++) {
    var item = allUrls[i];
    var url = item.url;
    var upper = url.toUpperCase();
    for (var p = 0; p < pats.length; p++) {
      if (upper.indexOf(pats[p].toUpperCase()) > -1 && !seen[url]) {
        seen[url] = true;
        out.push(item);
        break;
      }
    }
  }
  return out;
}

function selectMovieItems(allUrls) {
  var out = [], seen = {};
  for (var i = 0; i < allUrls.length; i++) {
    var item = allUrls[i];
    if (!item.url || seen[item.url]) continue;
    seen[item.url] = true;
    out.push(item);
  }
  return out;
}

module.exports = { getStreams: getStreams };
