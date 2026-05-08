// Master Provider — Iraq Scrapers v4.5.0
// يجرّب الثلاثة مزودين بالتوازي
// لو فشل واحد يكمل الباقين تلقائياً

var TMDB_KEY = "ee8ac8a9044c09a11cc362033f98c735";
var QUALITY_ORDER = { "1080p": 0, "720p": 1, "480p": 2, "360p": 3, "HLS": 4, "HD": 5 };

// ══════════════════════════════════════════
// SHARED HELPERS
// ══════════════════════════════════════════

function normalizeQuality(q) {
  if (!q) return "HD";
  if (typeof q === "number") return q + "p";
  return String(q).replace(/\s/g, "");
}

function sortByQuality(streams) {
  return streams.sort(function(a, b) {
    var oa = QUALITY_ORDER[a.quality] != null ? QUALITY_ORDER[a.quality] : 9;
    var ob = QUALITY_ORDER[b.quality] != null ? QUALITY_ORDER[b.quality] : 9;
    return oa - ob;
  });
}

function norm(s) {
  return (s || "").toLowerCase().replace(/[^\w\s\u0600-\u06FF]/g, "").replace(/\s+/g, " ").trim();
}

function similarity(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;
  var setA = a.split(" "), setB = b.split(" ");
  var common = 0;
  for (var i = 0; i < setA.length; i++)
    for (var j = 0; j < setB.length; j++)
      if (setA[i] === setB[j] && setA[i].length > 1) { common++; break; }
  return (2 * common) / (setA.length + setB.length);
}

function bestScore(titles, target) {
  var best = 0;
  for (var i = 0; i < titles.length; i++) {
    var s = similarity(titles[i], target);
    if (s > best) best = s;
  }
  return best;
}

function fetchTMDBData(tmdbId, mediaType) {
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
    add(ar.title); add(ar.name);
    var dateStr = en.release_date || en.first_air_date || "";
    var year = dateStr ? parseInt(dateStr.substring(0, 4)) : null;
    return { titles: titles.filter(Boolean), year: year };
  });
}

function pickBestMatch(results, titles, year) {
  if (!results || !results.length) return null;
  var scored = [];
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    var score = bestScore(titles, r.name || r.title || "");
    if (score < 0.4) continue;
    if (year && r.year) {
      var ry = parseInt(r.year);
      if (ry === year) score += 0.3;
      else if (Math.abs(ry - year) === 1) score += 0.1;
      else if (Math.abs(ry - year) > 2) score -= 0.2;
    }
    scored.push({ result: r, score: score });
  }
  if (!scored.length) return results[0];
  scored.sort(function(a, b) { return b.score - a.score; });
  return scored[0].result;
}

// ══════════════════════════════════════════
// CINEMANA
// ══════════════════════════════════════════

var CINEMANA_API = "https://cinemana.shabakaty.com/api/android/";

function cinemanaSearch(titles, year, idx, type, season, episode) {
  if (idx >= titles.length) return Promise.resolve([]);
  return fetch(CINEMANA_API + "AdvancedSearch?videoTitle=" + encodeURIComponent(titles[idx]) + "&type=" + type)
    .then(function(r) { return r.json(); })
    .then(function(results) {
      if (!results || !results.length) return cinemanaSearch(titles, year, idx + 1, type, season, episode);
      var match = pickBestMatch(results, titles, year);
      if (!match) return cinemanaSearch(titles, year, idx + 1, type, season, episode);
      var nb = match.nb;
      if (type === "series" && season && episode)
        return cinemanaTVFiles(nb, parseInt(season) || 1, parseInt(episode) || 1);
      return cinemanaFiles(nb);
    })
    .catch(function() { return cinemanaSearch(titles, year, idx + 1, type, season, episode); });
}

function cinemanaTVFiles(showNb, sNum, eNum) {
  return fetch(CINEMANA_API + "videoSeason/id/" + showNb)
    .then(function(r) { return r.json(); })
    .then(function(seasons) {
      if (!seasons || !seasons.length) return [];
      var seasonData = null;
      for (var i = 0; i < seasons.length; i++) {
        var sn = parseInt(seasons[i].season) || parseInt(seasons[i].seasonNumber) || (i + 1);
        if (sn === sNum) { seasonData = seasons[i]; break; }
      }
      if (!seasonData && seasons.length >= sNum) seasonData = seasons[sNum - 1];
      if (!seasonData) return [];
      var episodes = seasonData.episodes || [];
      var epNb = null;
      for (var j = 0; j < episodes.length; j++) {
        var en = parseInt(episodes[j].episodeNummer) || parseInt(episodes[j].episodeNumber) || (j + 1);
        if (en === eNum) { epNb = episodes[j].nb; break; }
      }
      if (!epNb && episodes.length >= eNum) epNb = episodes[eNum - 1].nb;
      if (!epNb) return [];
      return cinemanaFiles(epNb);
    })
    .catch(function() { return []; });
}

function cinemanaFiles(nb) {
  return fetch(CINEMANA_API + "transcoddedFiles/id/" + nb)
    .then(function(r) { return r.json(); })
    .then(function(files) {
      var streams = [], seen = {};
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        var url = f.videoUrl || f.url || f.transcoddedFile || "";
        var q = normalizeQuality(f.resolution || f.quality || "HD");
        if (url && !seen[url]) {
          seen[url] = true;
          streams.push({ title: "Cinemana " + q, name: "Cinemana", url: url, quality: q });
        }
      }
      return sortByQuality(streams);
    })
    .catch(function() { return []; });
}

function getCinemanaStreams(titles, year, mediaType, season, episode) {
  var type = mediaType === "movie" ? "movies" : "series";
  return cinemanaSearch(titles, year, 0, type, season, episode).catch(function() { return []; });
}

// ══════════════════════════════════════════
// CINEMABOX
// ══════════════════════════════════════════

var CB_API = "https://cinema.albox.co/api/v4/";

function cinemaboxSearch(titles, idx, mediaType, season, episode) {
  if (idx >= titles.length) return Promise.resolve([]);
  return fetch(CB_API + "search?q=" + encodeURIComponent(titles[idx]))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.results || !data.results.length)
        return cinemaboxSearch(titles, idx + 1, mediaType, season, episode);
      var targetType = mediaType === "movie" ? "MOVIE" : "SERIES";
      var match = null;
      for (var i = 0; i < data.results.length; i++) {
        if (data.results[i].type === targetType) { match = data.results[i]; break; }
      }
      if (!match) match = data.results[0];
      return fetch(CB_API + "shows/shows/dynamic/" + match.id)
        .then(function(r) { return r.json(); })
        .then(function(detail) {
          if (!detail.post_info) return cinemaboxSearch(titles, idx + 1, mediaType, season, episode);
          if (mediaType === "movie") {
            var epId = detail.post_info.episode_id;
            return epId ? cinemaboxPlayer(epId) : [];
          }
          return cinemaboxTV(detail, parseInt(season) || 1, parseInt(episode) || 1);
        });
    })
    .catch(function() { return cinemaboxSearch(titles, idx + 1, mediaType, season, episode); });
}

function cinemaboxTV(detail, sNum, eNum) {
  var sections = detail.sections || [], seasonEps = null;
  for (var i = 0; i < sections.length; i++) {
    var sec = sections[i], data = sec.data || [];
    if (!data.length || data[0].card_type !== "episode") continue;
    var secTitle = (sec.title || sec.name || "").toLowerCase();
    var secNum = parseInt(sec.season_number || sec.seasonNumber || sec.number || 0);
    if (secNum === sNum) { seasonEps = data; break; }
    if (secTitle.indexOf("season " + sNum) > -1 || secTitle.indexOf("الموسم " + sNum) > -1) { seasonEps = data; break; }
    if (!seasonEps) seasonEps = data;
  }
  if (!seasonEps || !seasonEps.length) {
    var epId = detail.post_info && detail.post_info.episode_id;
    return epId ? cinemaboxPlayer(epId) : Promise.resolve([]);
  }
  var ep = null;
  for (var j = 0; j < seasonEps.length; j++) {
    var num = parseInt(seasonEps[j].episode_number || seasonEps[j].episodeNumber || seasonEps[j].number || (j + 1));
    if (num === eNum) { ep = seasonEps[j]; break; }
  }
  if (!ep && seasonEps.length >= eNum) ep = seasonEps[eNum - 1];
  if (!ep) return Promise.resolve([]);
  return cinemaboxPlayer(ep.id);
}

function cinemaboxPlayer(episodeId) {
  return fetch(CB_API + "shows/episodes/player/" + episodeId)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var streams = [], seen = {};
      var videos = data.videos || [];
      for (var i = 0; i < videos.length; i++) {
        var v = videos[i];
        if (!v.url || seen[v.url]) continue;
        seen[v.url] = true;
        var q = normalizeQuality(v.quality || "HD");
        streams.push({ title: "CinemaBox " + q, name: "CinemaBox", url: v.url, quality: q });
      }
      if (!streams.length) {
        var text = JSON.stringify(data);
        var re = /(https?:\/\/cloud[0-9]*\.albox\.co\/episodes\/[^"'\s,\]]+\.mp4)/gi, m;
        while ((m = re.exec(text)) !== null) {
          if (!seen[m[1]]) { seen[m[1]] = true; streams.push({ title: "CinemaBox HD", name: "CinemaBox", url: m[1], quality: "HD" }); }
        }
      }
      return sortByQuality(streams);
    })
    .catch(function() { return []; });
}

function getCinemaBoxStreams(titles, mediaType, season, episode) {
  return cinemaboxSearch(titles, 0, mediaType, season, episode).catch(function() { return []; });
}

// ══════════════════════════════════════════
// VODU
// ══════════════════════════════════════════

function voduGetQ(url) {
  if (/-1080\./i.test(url)) return "1080p";
  if (/-720\./i.test(url))  return "720p";
  if (/-480\./i.test(url))  return "480p";
  if (/-360\./i.test(url))  return "360p";
  if (/\.m3u8/i.test(url))  return "HLS";
  return "HD";
}

function voduSkip(url) {
  return (/-t\.(mp4|m3u8)/i.test(url) || /_t\.(mp4|m3u8)/i.test(url) || /thumb|trailer|preview|poster/i.test(url));
}

function voduGetUrls(html) {
  var urls = [], m;
  var pats = [
    /["'](https?:\/\/[^"'\s]*:8888\/[^"'\s]+\.(?:mp4|m3u8)[^"'\s]*)/gi,
    /<(?:source|video)[^>]*src=["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)/gi,
    /(?:file|src|url|videoUrl)\s*[:=]\s*["'](https?:\/\/[^"'\s]+\.(?:mp4|m3u8)[^"'\s]*)/gi,
    /["'](https?:\/\/[^"'\s]+\.(?:mp4|m3u8)(?:\?[^"'\s]*)?)/gi
  ];
  for (var p = 0; p < pats.length; p++) {
    while ((m = pats[p].exec(html)) !== null) {
      var u = m[1].replace(/\\\//g, "/").replace(/&amp;/g, "&");
      if (urls.indexOf(u) === -1) urls.push(u);
    }
  }
  return urls;
}

function voduSearch(titles, idx, mediaType, season, episode) {
  if (idx >= titles.length) return Promise.resolve([]);
  return fetch("https://movie.vodu.me/index.php?do=list&title=" + encodeURIComponent(titles[idx]))
    .then(function(r) { return r.text(); })
    .then(function(html) {
      var links = [], m, re = /href=["']([^"']*do=view[^"']*)["']/gi;
      while ((m = re.exec(html)) !== null) {
        var href = m[1].replace(/&amp;/g, "&");
        if (href.indexOf("http") !== 0) href = "https://movie.vodu.me/" + href.replace(/^\//, "");
        if (links.indexOf(href) === -1) links.push(href);
      }
      if (!links.length) return voduSearch(titles, idx + 1, mediaType, season, episode);
      return voduTryLinks(links, 0, mediaType, season, episode);
    })
    .catch(function() { return voduSearch(titles, idx + 1, mediaType, season, episode); });
}

function voduTryLinks(links, idx, mediaType, season, episode) {
  if (idx >= links.length) return Promise.resolve([]);
  return fetch(links[idx])
    .then(function(r) { return r.text(); })
    .then(function(html) {
      var allUrls = voduGetUrls(html), streams;
      if ((mediaType === "tv" || mediaType === "series") && season && episode) {
        var sNum = parseInt(season) || 1, eNum = parseInt(episode) || 1;
        var sStr = sNum < 10 ? "0" + sNum : "" + sNum;
        var eStr = eNum < 10 ? "0" + eNum : "" + eNum;
        var pats = ["S" + sStr + "E" + eStr, "s" + sStr + "e" + eStr, "S" + sNum + "E" + eNum];
        streams = [];
        var seen = {};
        for (var i = 0; i < allUrls.length; i++) {
          var url = allUrls[i];
          if (voduSkip(url)) continue;
          var upper = url.toUpperCase();
          for (var p = 0; p < pats.length; p++) {
            if (upper.indexOf(pats[p].toUpperCase()) > -1 && !seen[url]) {
              seen[url] = true;
              streams.push({ title: "VODU " + voduGetQ(url), name: "VODU", url: url, quality: voduGetQ(url) });
              break;
            }
          }
        }
      } else {
        streams = [];
        var seen2 = {};
        for (var i2 = 0; i2 < allUrls.length; i2++) {
          var url2 = allUrls[i2];
          if (voduSkip(url2) || seen2[url2]) continue;
          seen2[url2] = true;
          streams.push({ title: "VODU " + voduGetQ(url2), name: "VODU", url: url2, quality: voduGetQ(url2) });
        }
      }
      if (streams.length) return sortByQuality(streams);
      return voduTryLinks(links, idx + 1, mediaType, season, episode);
    })
    .catch(function() { return voduTryLinks(links, idx + 1, mediaType, season, episode); });
}

function getVODUStreams(titles, mediaType, season, episode) {
  return voduSearch(titles, 0, mediaType, season, episode).catch(function() { return []; });
}

// ══════════════════════════════════════════
// MASTER — يجرّب الكل بالتوازي
// ══════════════════════════════════════════

function getStreams(tmdbId, mediaType, season, episode) {
  return fetchTMDBData(tmdbId, mediaType)
    .then(function(data) {
      if (!data.titles.length) return [];

      // ✅ الثلاثة يشتغلون بالتوازي — لو فشل واحد ما يأثر على الباقين
      return Promise.all([
        getCinemanaStreams(data.titles, data.year, mediaType, season, episode),
        getCinemaBoxStreams(data.titles, mediaType, season, episode),
        getVODUStreams(data.titles, mediaType, season, episode)
      ]).then(function(results) {
        var cinemana  = results[0] || [];
        var cinemabox = results[1] || [];
        var vodu      = results[2] || [];

        // ✅ لو الكل فاضي — ارجع []
        if (!cinemana.length && !cinemabox.length && !vodu.length) return [];

        // ✅ ادمج كل النتائج ورتّبها بالجودة
        var all = cinemana.concat(cinemabox).concat(vodu);
        return sortByQuality(all);
      });
    })
    .catch(function() { return []; });
}

module.exports = { getStreams: getStreams };
