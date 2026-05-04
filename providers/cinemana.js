// ============================================================
// cinemana.js — Cinemana provider مع دعم الترجمات
// ============================================================
var utils = require("./utils");

var API = "https://cinemana.shabakaty.com/api/android/";

function getStreams(tmdbId, mediaType, season, episode) {
  return utils.fetchTMDBTitles(tmdbId, mediaType)
    .then(function(titles) {
      if (titles.length === 0) return [];
      var type = mediaType === "movie" ? "movies" : "series";
      return searchCinemana(titles, 0, type, season, episode);
    })
    .catch(function() { return []; });
}

function searchCinemana(titles, idx, type, season, episode) {
  if (idx >= titles.length) return [];
  return utils.fetchWithTimeout(API + "AdvancedSearch?videoTitle=" + encodeURIComponent(titles[idx]) + "&type=" + type)
    .then(function(r) { return r.json(); })
    .then(function(results) {
      if (!results || results.length === 0)
        return searchCinemana(titles, idx + 1, type, season, episode);

      var nb = results[0].nb;
      if (type === "series" && season && episode)
        return getTVFiles(nb, parseInt(season) || 1, parseInt(episode) || 1);
      return getFiles(nb);
    })
    .catch(function() { return searchCinemana(titles, idx + 1, type, season, episode); });
}

function getTVFiles(showNb, sNum, eNum) {
  return utils.fetchWithTimeout(API + "videoSeason/id/" + showNb)
    .then(function(r) { return r.json(); })
    .then(function(seasons) {
      if (!seasons || seasons.length === 0) return getFiles(showNb);

      var seasonData = null;
      for (var i = 0; i < seasons.length; i++) {
        var s = seasons[i];
        var sn = parseInt(s.season) || parseInt(s.seasonNumber) || (i + 1);
        if (sn === sNum) { seasonData = s; break; }
      }
      if (!seasonData && seasons.length >= sNum) seasonData = seasons[sNum - 1];
      if (!seasonData) return [];

      var episodes = seasonData.episodes || [];
      if (episodes.length === 0) return getFiles(showNb);

      var epNb = null;
      for (var j = 0; j < episodes.length; j++) {
        var ep = episodes[j];
        var en = parseInt(ep.episodeNummer) || parseInt(ep.episodeNumber) || (j + 1);
        if (en === eNum) { epNb = ep.nb; break; }
      }
      if (!epNb && episodes.length >= eNum) epNb = episodes[eNum - 1].nb;

      // ✅ إصلاح: إذا ما لقينا حلقة، نرجع [] بدل محتوى الـ show الكامل
      if (!epNb) return [];
      return getFiles(epNb);
    })
    .catch(function() { return []; });
}

function getFiles(nb) {
  return utils.fetchWithTimeout(API + "transcoddedFiles/id/" + nb)
    .then(function(r) { return r.json(); })
    .then(function(files) {
      // جلب الترجمات بطلب منفصل
      return utils.fetchWithTimeout(API + "videoSubtitles/id/" + nb)
        .then(function(r2) { return r2.json(); })
        .catch(function() { return []; })
        .then(function(subsData) {
          var subtitles = extractCinemanaSubtitles(subsData);
          return buildStreams(files, subtitles);
        });
    })
    .catch(function() { return []; });
}

function buildStreams(files, subtitles) {
  var streams = [];
  var seen = {};
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    var url = f.videoUrl || f.url || f.transcoddedFile || "";
    var q = utils.normalizeQuality(f.resolution || f.quality || "HD");
    if (url && !seen[url]) {
      seen[url] = true;
      streams.push({ name: "Cinemana", title: "Cinemana " + q, url: url, quality: q, subtitles: subtitles });
    }
  }
  return utils.sortByQuality(streams);
}

/**
 * استخراج الترجمات من endpoint الترجمات
 * Cinemana API: /videoSubtitles/id/{nb}
 * الـ response المتوقع: [{ language, url, label }, ...]
 * أو: { subtitles: [...] }
 */
function extractCinemanaSubtitles(data) {
  var subs = [];
  var seen = {};
  var raw = Array.isArray(data) ? data : (data.subtitles || data.tracks || []);

  for (var i = 0; i < raw.length; i++) {
    var s = raw[i];
    // الأسماء الممكنة للرابط في Cinemana API
    var url = s.url || s.subtitleUrl || s.file || s.link || "";
    var lang = s.language || s.lang || s.languageCode || "ar";
    var label = s.label || s.languageName || s.name || (lang === "ar" ? "عربي" : lang);

    if (url && !seen[url]) {
      seen[url] = true;
      var sub = utils.makeSubtitle(url, lang, label);
      if (sub) subs.push(sub);
    }
  }

  return subs;
}

module.exports = { getStreams: getStreams };
