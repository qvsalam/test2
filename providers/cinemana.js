// Cinemana Provider — Iraq Scrapers v4.2.0
// Fixed for Nuvio QuickJS runtime (no setTimeout)

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

function fetchTMDBTitles(tmdbId, mediaType) {
  var path = "/" + (mediaType === "movie" ? "movie" : "tv") + "/" + tmdbId;
  var base = "https://api.themoviedb.org/3" + path + "?api_key=" + TMDB_API_KEY;
  return Promise.all([
    fetch(base + "&language=en").then(function(r) { return r.json(); }).catch(function() { return {}; }),
    fetch(base + "&language=ar").then(function(r) { return r.json(); }).catch(function() { return {}; })
  ]).then(function(res) {
    var en = res[0], ar = res[1];
    var titles = [];
    function add(t) { if (t && titles.indexOf(t) === -1) titles.push(t); }
    add(en.title); add(en.original_title); add(en.name); add(en.original_name);
    add(ar.title); add(ar.name);
    return titles.filter(Boolean);
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  return fetchTMDBTitles(tmdbId, mediaType)
    .then(function(titles) {
      if (!titles.length) return [];
      var type = mediaType === "movie" ? "movies" : "series";
      return searchCinemana(titles, 0, type, season, episode);
    })
    .catch(function() { return []; });
}

function searchCinemana(titles, idx, type, season, episode) {
  if (idx >= titles.length) return Promise.resolve([]);
  return fetch(API + "AdvancedSearch?videoTitle=" + encodeURIComponent(titles[idx]) + "&type=" + type)
    .then(function(r) { return r.json(); })
    .then(function(results) {
      if (!results || !results.length)
        return searchCinemana(titles, idx + 1, type, season, episode);
      var nb = results[0].nb;
      if (type === "series" && season && episode)
        return getTVFiles(nb, parseInt(season) || 1, parseInt(episode) || 1);
      return getFiles(nb);
    })
    .catch(function() { return searchCinemana(titles, idx + 1, type, season, episode); });
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
