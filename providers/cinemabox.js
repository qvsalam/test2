// CinemaBox Provider — Iraq Scrapers v4.2.0
// Fixed for Nuvio QuickJS runtime (no setTimeout)

var API = "https://cinema.albox.co/api/v4/";
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
      return searchCB(titles, 0, mediaType, season, episode);
    })
    .catch(function() { return []; });
}

function searchCB(titles, idx, mediaType, season, episode) {
  if (idx >= titles.length) return Promise.resolve([]);
  return fetch(API + "search?q=" + encodeURIComponent(titles[idx]))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.results || !data.results.length)
        return searchCB(titles, idx + 1, mediaType, season, episode);

      var targetType = mediaType === "movie" ? "MOVIE" : "SERIES";
      var match = null;
      for (var i = 0; i < data.results.length; i++) {
        if (data.results[i].type === targetType) { match = data.results[i]; break; }
      }
      if (!match) match = data.results[0];

      return fetch(API + "shows/shows/dynamic/" + match.id)
        .then(function(r) { return r.json(); })
        .then(function(detail) {
          if (!detail.post_info)
            return searchCB(titles, idx + 1, mediaType, season, episode);
          if (mediaType === "movie") {
            var epId = detail.post_info.episode_id;
            if (!epId) return [];
            return getPlayerStreams(epId);
          }
          return getTVStreams(detail, parseInt(season) || 1, parseInt(episode) || 1);
        });
    })
    .catch(function() { return searchCB(titles, idx + 1, mediaType, season, episode); });
}

function getTVStreams(detail, sNum, eNum) {
  var sections = detail.sections || [];
  var seasonEps = null;

  for (var i = 0; i < sections.length; i++) {
    var sec = sections[i];
    var data = sec.data || [];
    if (!data.length || data[0].card_type !== "episode") continue;
    var secTitle = (sec.title || sec.name || "").toLowerCase();
    var secNum = parseInt(sec.season_number || sec.seasonNumber || sec.number || 0);
    if (secNum === sNum) { seasonEps = data; break; }
    if (secTitle.indexOf("season " + sNum) > -1 || secTitle.indexOf("الموسم " + sNum) > -1) { seasonEps = data; break; }
    if (!seasonEps) seasonEps = data;
  }

  if (!seasonEps || !seasonEps.length) {
    var epId = detail.post_info && detail.post_info.episode_id;
    return epId ? getPlayerStreams(epId) : Promise.resolve([]);
  }

  var ep = null;
  for (var j = 0; j < seasonEps.length; j++) {
    var num = parseInt(seasonEps[j].episode_number || seasonEps[j].episodeNumber || seasonEps[j].number || (j + 1));
    if (num === eNum) { ep = seasonEps[j]; break; }
  }
  if (!ep && seasonEps.length >= eNum) ep = seasonEps[eNum - 1];
  if (!ep) return Promise.resolve([]);
  return getPlayerStreams(ep.id);
}

function getPlayerStreams(episodeId) {
  return fetch(API + "shows/episodes/player/" + episodeId)
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
        var re = /(https?:\/\/cloud[0-9]*\.albox\.co\/episodes\/[^"'\s,\]]+\.mp4)/gi;
        var m;
        while ((m = re.exec(text)) !== null) {
          if (!seen[m[1]]) {
            seen[m[1]] = true;
            streams.push({ title: "CinemaBox HD", name: "CinemaBox", url: m[1], quality: "HD" });
          }
        }
      }
      return sortByQuality(streams);
    })
    .catch(function() { return []; });
}

module.exports = { getStreams: getStreams };
