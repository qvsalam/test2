function getStreams(tmdbId, mediaType, season, episode) {
  var API = "https://cinemana.shabakaty.com/api/android/";
  var tmdbPath = "/" + (mediaType === "movie" ? "movie" : "tv") + "/" + tmdbId;
  var tmdbUrl = "https://api.themoviedb.org/3" + tmdbPath + "?api_key=" + TMDB_API_KEY + "&language=en";

  return fetch(tmdbUrl)
    .then(function(r) { return r.json(); })
    .then(function(info) {
      var titles = [];
      if (info.title) titles.push(info.title);
      if (info.original_title && titles.indexOf(info.original_title) === -1) titles.push(info.original_title);
      if (info.name) titles.push(info.name);
      if (info.original_name && titles.indexOf(info.original_name) === -1) titles.push(info.original_name);
      if (titles.length === 0) return [];
      var type = mediaType === "movie" ? "movies" : "series";
      return searchCinemana(API, titles, 0, type, season, episode);
    })
    .catch(function() { return []; });
}

function searchCinemana(API, titles, idx, type, season, episode) {
  if (idx >= titles.length) return [];
  return fetch(API + "AdvancedSearch?videoTitle=" + encodeURIComponent(titles[idx]) + "&type=" + type)
    .then(function(r) { return r.json(); })
    .then(function(results) {
      if (!results || results.length === 0) {
        return searchCinemana(API, titles, idx + 1, type, season, episode);
      }
      var nb = results[0].nb;
      if (type === "series" && season && episode) {
        return getTVFiles(API, nb, parseInt(season) || 1, parseInt(episode) || 1);
      }
      return getFiles(API, nb);
    })
    .catch(function() { return searchCinemana(API, titles, idx + 1, type, season, episode); });
}

function getTVFiles(API, showNb, sNum, eNum) {
  return fetch(API + "videoSeason/id/" + showNb)
    .then(function(r) { return r.json(); })
    .then(function(seasons) {
      if (!seasons || seasons.length === 0) return getFiles(API, showNb);
      var seasonData = null;
      for (var i = 0; i < seasons.length; i++) {
        var s = seasons[i];
        var sn = parseInt(s.season) || parseInt(s.seasonNumber) || (i + 1);
        if (sn === sNum) { seasonData = s; break; }
      }
      if (!seasonData && seasons.length >= sNum) seasonData = seasons[sNum - 1];
      if (!seasonData) return [];
      var episodes = seasonData.episodes || [];
      if (episodes.length === 0) return getFiles(API, showNb);
      var epNb = null;
      for (var j = 0; j < episodes.length; j++) {
        var ep = episodes[j];
        var en = parseInt(ep.episodeNummer) || parseInt(ep.episodeNumber) || (j + 1);
        if (en === eNum) { epNb = ep.nb; break; }
      }
      if (!epNb && episodes.length >= eNum) epNb = episodes[eNum - 1].nb;
      if (!epNb) return [];
      return getFiles(API, epNb);
    })
    .catch(function() { return getFiles(API, showNb); });
}

function getFiles(API, nb) {
  return fetch(API + "transcoddedFiles/id/" + nb)
    .then(function(r) { return r.json(); })
    .then(function(files) {
      var streams = [];
      var seen = {};
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        var url = f.videoUrl || f.url || f.transcoddedFile || "";
        var q = f.resolution || f.quality || "HD";
        if (typeof q === "number") q = q + "p";
        q = q.replace(/\s/g, "");
        if (url && !seen[url]) {
          seen[url] = true;
          streams.push({ name: "Cinemana", title: "Cinemana " + q, url: url, quality: q });
        }
      }
      var order = {"1080p": 0, "720p": 1, "480p": 2, "360p": 3, "240p": 4, "HD": 5};
      streams.sort(function(a, b) {
        return (order[a.quality] != null ? order[a.quality] : 9) - (order[b.quality] != null ? order[b.quality] : 9);
      });
      return streams;
    })
    .catch(function() { return []; });
}

module.exports = { getStreams: getStreams };
