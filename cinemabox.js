function getStreams(tmdbId, mediaType, season, episode) {
  var tmdbPath = "/" + (mediaType === "movie" ? "movie" : "tv") + "/" + tmdbId;
  var tmdbUrl = "https://api.themoviedb.org/3" + tmdbPath + "?api_key=" + TMDB_API_KEY + "&language=en";
  var API = "https://cinema.albox.co/api/v4/";

  return fetch(tmdbUrl)
    .then(function(r) { return r.json(); })
    .then(function(info) {
      var titles = [];
      if (info.title) titles.push(info.title);
      if (info.original_title && titles.indexOf(info.original_title) === -1) titles.push(info.original_title);
      if (info.name) titles.push(info.name);
      if (info.original_name && titles.indexOf(info.original_name) === -1) titles.push(info.original_name);
      if (titles.length === 0) return [];
      return searchCB(API, titles, 0, mediaType, season, episode);
    })
    .catch(function() { return []; });
}

function searchCB(API, titles, idx, mediaType, season, episode) {
  if (idx >= titles.length) return [];
  return fetch(API + "search?q=" + encodeURIComponent(titles[idx]))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.results || data.results.length === 0) {
        return searchCB(API, titles, idx + 1, mediaType, season, episode);
      }
      var targetType = mediaType === "movie" ? "MOVIE" : "SERIES";
      var match = null;
      for (var i = 0; i < data.results.length; i++) {
        if (data.results[i].type === targetType) { match = data.results[i]; break; }
      }
      if (!match) match = data.results[0];
      return fetch(API + "shows/shows/dynamic/" + match.id)
        .then(function(r2) { return r2.json(); })
        .then(function(detail) {
          if (!detail.post_info) return searchCB(API, titles, idx + 1, mediaType, season, episode);
          if (mediaType === "movie") {
            var epId = detail.post_info.episode_id;
            if (!epId) return [];
            return getPlayerStreams(API, epId);
          } else {
            return getTVStreams(API, detail, match.id, parseInt(season) || 1, parseInt(episode) || 1);
          }
        });
    })
    .catch(function() { return searchCB(API, titles, idx + 1, mediaType, season, episode); });
}

function getTVStreams(API, detail, showId, sNum, eNum) {
  var sections = detail.sections || [];
  var seasonItems = [];
  for (var i = 0; i < sections.length; i++) {
    var sec = sections[i];
    if (sec.data && sec.data.length > 0 && sec.data[0].card_type === "episode") {
      seasonItems = sec.data || [];
      break;
    }
  }
  if (seasonItems.length > 0 && eNum <= seasonItems.length) {
    var ep = seasonItems[eNum - 1];
    if (ep && ep.id) return getPlayerStreams(API, ep.id);
  }
  if (detail.post_info && detail.post_info.episode_id) {
    return getPlayerStreams(API, detail.post_info.episode_id);
  }
  return Promise.resolve([]);
}

function getPlayerStreams(API, episodeId) {
  return fetch(API + "shows/episodes/player/" + episodeId)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var streams = [];
      var seen = {};
      var videos = data.videos || [];
      for (var i = 0; i < videos.length; i++) {
        var v = videos[i];
        if (v.url && !seen[v.url]) {
          seen[v.url] = true;
          var q = v.quality || "HD";
          if (typeof q === "number") q = q + "p";
          streams.push({ name: "CinemaBox", title: "CinemaBox " + q, url: v.url, quality: q });
        }
      }
      if (streams.length === 0) {
        var text = JSON.stringify(data);
        var re = /(https?:\/\/cloud[0-9]*\.albox\.co\/episodes\/[^"'\s,\]]+\.mp4)/gi;
        var m;
        while ((m = re.exec(text)) !== null) {
          if (!seen[m[1]]) {
            seen[m[1]] = true;
            streams.push({ name: "CinemaBox", title: "CinemaBox HD", url: m[1], quality: "HD" });
          }
        }
      }
      var order = {"1080p": 0, "1080": 0, "720p": 1, "720": 1, "480p": 2, "480": 2, "360p": 3, "360": 3, "HD": 4};
      streams.sort(function(a, b) {
        return (order[a.quality] != null ? order[a.quality] : 9) - (order[b.quality] != null ? order[b.quality] : 9);
      });
      return streams;
    })
    .catch(function() { return []; });
}
module.exports = { getStreams: getStreams };
