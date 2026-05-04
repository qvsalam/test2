// ============================================================
// vodu.js — VODU provider مع دعم الترجمات
// ============================================================
var utils = require("./utils");

function getStreams(tmdbId, mediaType, season, episode) {
  return utils.fetchTMDBTitles(tmdbId, mediaType)
    .then(function(titles) {
      if (titles.length === 0) return [];
      return searchVODU(titles, 0, mediaType, season, episode);
    })
    .catch(function() { return []; });
}

function searchVODU(titles, idx, mediaType, season, episode) {
  if (idx >= titles.length) return [];
  return utils.fetchWithTimeout("https://movie.vodu.me/index.php?do=list&title=" + encodeURIComponent(titles[idx]))
    .then(function(r) { return r.text(); })
    .then(function(html) {
      var links = [];
      var re = /href=["']([^"']*do=view[^"']*)['"]/gi;
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
  return utils.fetchWithTimeout(links[idx])
    .then(function(r) { return r.text(); })
    .then(function(html) {
      var allUrls = getAllVideoUrls(html);
      var subtitles = extractVODUSubtitles(html); // ✅ استخراج الترجمات من HTML
      var streams;
      if ((mediaType === "tv" || mediaType === "series") && season && episode) {
        streams = filterEpisode(allUrls, parseInt(season) || 1, parseInt(episode) || 1, html, subtitles);
      } else {
        streams = filterMovieUrls(allUrls, html, subtitles);
      }
      if (streams.length > 0) return streams;
      return tryLinks(links, idx + 1, mediaType, season, episode);
    })
    .catch(function() { return tryLinks(links, idx + 1, mediaType, season, episode); });
}

// ── استخراج الترجمات من صفحة VODU ────────────────────────────
/**
 * VODU يضع الترجمات داخل <track> tags أو كمصفوفة JS
 * نبحث عن كل الأنماط الممكنة
 */
function extractVODUSubtitles(html) {
  var subs = [];
  var seen = {};

  // 1) HTML5 <track kind="subtitles" src="..." srclang="ar" label="عربي">
  var trackRe = /<track[^>]+kind=["'](?:subtitles|captions)["'][^>]*>/gi;
  var trackMatch;
  while ((trackMatch = trackRe.exec(html)) !== null) {
    var tag = trackMatch[0];
    var srcM = /src=["']([^"']+)["']/.exec(tag);
    var langM = /srclang=["']([^"']+)["']/.exec(tag);
    var labelM = /label=["']([^"']+)["']/.exec(tag);
    if (srcM && srcM[1]) {
      var url = srcM[1];
      if (!seen[url]) {
        seen[url] = true;
        var sub = utils.makeSubtitle(url, (langM && langM[1]) || "ar", (labelM && labelM[1]) || "عربي");
        if (sub) subs.push(sub);
      }
    }
  }

  // 2) JavaScript: { file: "...vtt", label: "Arabic", kind: "captions" }
  var jsRe = /\{\s*(?:file|src|url)\s*:\s*["'](https?:\/\/[^"']+\.(?:vtt|srt))["'][^}]*(?:label|lang)[^:]*:\s*["']([^"']*)["'][^}]*\}/gi;
  var jsMatch;
  while ((jsMatch = jsRe.exec(html)) !== null) {
    var jurl = jsMatch[1];
    if (!seen[jurl]) {
      seen[jurl] = true;
      subs.push(utils.makeSubtitle(jurl, "ar", jsMatch[2] || "عربي"));
    }
  }

  // 3) fallback: أي رابط .vtt أو .srt في الصفحة
  if (subs.length === 0) {
    var fbRe = /(https?:\/\/[^"'\s<>]+\.(?:vtt|srt))(?:\?[^"'\s<>]*)?/gi;
    var fbM;
    while ((fbM = fbRe.exec(html)) !== null) {
      if (!seen[fbM[1]] && !/thumb|poster|preview/i.test(fbM[1])) {
        seen[fbM[1]] = true;
        subs.push(utils.makeSubtitle(fbM[1], "ar", "عربي"));
      }
    }
  }

  return subs;
}

// ── باقي الدوال مع تمرير الترجمات ────────────────────────────

function filterEpisode(allUrls, sNum, eNum, html, subtitles) {
  var sStr = sNum < 10 ? "0" + sNum : "" + sNum;
  var eStr = eNum < 10 ? "0" + eNum : "" + eNum;
  var pats = ["S" + sStr + "E" + eStr, "s" + sStr + "e" + eStr, "S" + sNum + "E" + eNum, "s" + sNum + "e" + eNum];
  var streams = [];
  var seen = {};

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

  // fallback: بحث برقم الحلقة فقط
  if (streams.length === 0) {
    var epPats = ["_E" + eStr + "_", "_E" + eStr + "-", "_E" + eStr + ".", "_E" + eNum + "_", "E" + eStr + "_", "_" + eStr + "_"];
    for (var i2 = 0; i2 < allUrls.length; i2++) {
      var url2 = allUrls[i2];
      if (isSkip(url2)) continue;
      var upper2 = url2.toUpperCase();
      for (var p2 = 0; p2 < epPats.length; p2++) {
        if (upper2.indexOf(epPats[p2].toUpperCase()) > -1 && !seen[url2]) {
          seen[url2] = true;
          streams.push({ name: "VODU", title: "VODU " + getQ(url2), url: url2, quality: getQ(url2), subtitles: subtitles });
          break;
        }
      }
    }
  }

  return utils.sortByQuality(streams);
}

function filterMovieUrls(allUrls, html, subtitles) {
  var streams = [];
  var seen = {};
  for (var i = 0; i < allUrls.length; i++) {
    var url = allUrls[i];
    if (isSkip(url) || seen[url]) continue;
    seen[url] = true;
    streams.push({ name: "VODU", title: "VODU " + getQ(url), url: url, quality: getQ(url), subtitles: subtitles });
  }
  return utils.sortByQuality(streams);
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

module.exports = { getStreams: getStreams };
