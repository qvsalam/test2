// Cinemana Provider — Iraq Scrapers v4.4.0
// Year-aware matching to avoid wrong series

var TMDB_KEY = "ee8ac8a9044c09a11cc362033f98c735";
var API = "https://cinemana.shabakaty.com/api/android/";
var QUALITY_ORDER = { "1080p": 0, "720p": 1, "480p": 2, "360p": 3, "HLS": 4, "HD": 5 };

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

// ── نسبة تشابه بين نصين ───────────────────────────────────────
function norm(s) {
  return (s || "").toLowerCase()
    .replace(/[^\w\s\u0600-\u06FF]/g, "")
    .replace(/\s+/g, " ").trim();
}

function similarity(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;
  var setA = a.split(" "), setB = b.split(" ");
  var common = 0;
  for (var i = 0; i < setA.length; i++) {
    for (var j = 0; j < setB.length; j++) {
      if (setA[i] === setB[j] && setA[i].length > 1) { common++; break; }
    }
  }
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

// ── جلب TMDB مع السنة والعناوين ──────────────────────────────
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

    // ✅ استخراج السنة
    var dateStr = en.release_date || en.first_air_date || "";
    var year = dateStr ? parseInt(dateStr.substring(0, 4)) : null;

    return { titles: titles.filter(Boolean), year: year };
  });
}

// ── اختيار أفضل نتيجة بحث ────────────────────────────────────
function pickBestMatch(results, titles, year) {
  if (!results || !results.length) return null;

  var scored = [];
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    var score = bestScore(titles, r.name || r.title || "");
    if (score < 0.4) continue;

    // ✅ مطابقة السنة تزيد النقاط
    if (year && r.year) {
      var resultYear = parseInt(r.year);
      if (resultYear === year) score += 0.3;
      else if (Math.abs(resultYear - year) === 1) score += 0.1; // فرق سنة واحدة مقبول
      else if (Math.abs(resultYear - year) > 2) score -= 0.2;  // فرق كبير = عقوبة
    }

    scored.push({ result: r, score: score });
  }

  if (!scored.length) return results[0]; // fallback لأول نتيجة
  scored.sort(function(a, b) { return b.score - a.score; });
  return scored[0].result;
}

// ── Main ──────────────────────────────────────────────────────

function getStreams(tmdbId, mediaType, season, episode) {
  return fetchTMDBData(tmdbId, mediaType)
    .then(function(data) {
      if (!data.titles.length) return [];
      var type = mediaType === "movie" ? "movies" : "series";
      return searchCinemana(data.titles, data.year, 0, type, season, episode);
    })
    .catch(function() { return []; });
}

function searchCinemana(titles, year, idx, type, season, episode) {
  if (idx >= titles.length) return Promise.resolve([]);
  return fetch(API + "AdvancedSearch?videoTitle=" + encodeURIComponent(titles[idx]) + "&type=" + type)
    .then(function(r) { return r.json(); })
    .then(function(results) {
      if (!results || !results.length)
        return searchCinemana(titles, year, idx + 1, type, season, episode);

      // ✅ اختيار أفضل نتيجة بدل أول نتيجة دايماً
      var match = pickBestMatch(results, titles, year);
      if (!match) return searchCinemana(titles, year, idx + 1, type, season, episode);

      var nb = match.nb;
      if (type === "series" && season && episode)
        return getTVFiles(nb, parseInt(season) || 1, parseInt(episode) || 1);
      return getFiles(nb);
    })
    .catch(function() { return searchCinemana(titles, year, idx + 1, type, season, episode); });
}

function getTVFiles(showNb, sNum, eNum) {
  return fetch(API + "videoSeason/id/" + showNb)
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
      if (!episodes.length) return [];
      var epNb = null;
      for (var j = 0; j < episodes.length; j++) {
        var en = parseInt(episodes[j].episodeNummer) || parseInt(episodes[j].episodeNumber) || (j + 1);
        if (en === eNum) { epNb = episodes[j].nb; break; }
      }
      if (!epNb && episodes.length >= eNum) epNb = episodes[eNum - 1].nb;
      if (!epNb) return [];
      return getFiles(epNb);
    })
    .catch(function() { return []; });
}

function getFiles(nb) {
  return fetch(API + "transcoddedFiles/id/" + nb)
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

module.exports = { getStreams: getStreams };
