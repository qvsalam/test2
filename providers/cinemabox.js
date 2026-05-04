// ============================================================
// cinemabox.js — CinemaBox provider مع دعم الترجمات
// ============================================================
var utils = require("./utils");

var API = "https://cinema.albox.co/api/v4/";

function getStreams(tmdbId, mediaType, season, episode) {
  return utils.fetchTMDBTitles(tmdbId, mediaType)
    .then(function(titles) {
      if (titles.length === 0) return [];
      return searchCB(titles, 0, mediaType, season, episode);
    })
    .catch(function() { return []; });
}

function searchCB(titles, idx, mediaType, season, episode) {
  if (idx >= titles.length) return [];
  return utils.fetchWithTimeout(API + "search?q=" + encodeURIComponent(titles[idx]))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.results || data.results.length === 0)
        return searchCB(titles, idx + 1, mediaType, season, episode);

      var targetType = mediaType === "movie" ? "MOVIE" : "SERIES";
      var match = null;
      for (var i = 0; i < data.results.length; i++) {
        if (data.results[i].type === targetType) { match = data.results[i]; break; }
      }
      if (!match) match = data.results[0];

      return utils.fetchWithTimeout(API + "shows/shows/dynamic/" + match.id)
        .then(function(r2) { return r2.json(); })
        .then(function(detail) {
          if (!detail.post_info) return searchCB(titles, idx + 1, mediaType, season, episode);

          if (mediaType === "movie") {
            var epId = detail.post_info.episode_id;
            if (!epId) return [];
            return getPlayerStreams(epId);
          } else {
            return getTVStreams(detail, match.id, parseInt(season) || 1, parseInt(episode) || 1);
          }
        });
    })
    .catch(function() { return searchCB(titles, idx + 1, mediaType, season, episode); });
}

function getTVStreams(detail, showId, sNum, eNum) {
  var sections = detail.sections || [];

  // ✅ إصلاح: البحث عن الموسم الصحيح بدل أخذ أول section
  var seasonEpisodes = null;

  for (var i = 0; i < sections.length; i++) {
    var sec = sections[i];
    var data = sec.data || [];
    if (data.length === 0 || data[0].card_type !== "episode") continue;

    // محاولة مطابقة رقم الموسم من العنوان أو الترقيم
    var secTitle = (sec.title || sec.name || "").toLowerCase();
    var secNum = parseInt(sec.season_number || sec.seasonNumber || sec.number || 0);

    if (secNum === sNum) { seasonEpisodes = data; break; }
    if (secTitle.indexOf("season " + sNum) > -1 || secTitle.indexOf("الموسم " + sNum) > -1) {
      seasonEpisodes = data; break;
    }
    // fallback: الموسم بالترتيب
    if (secNum === 0 && !seasonEpisodes) seasonEpisodes = data;
  }

  if (!seasonEpisodes || seasonEpisodes.length === 0) {
    // fallback للـ episode_id المباشر
    var epId = detail.post_info && detail.post_info.episode_id;
    return epId ? getPlayerStreams(epId) : Promise.resolve([]);
  }

  // إيجاد الحلقة المطلوبة
  var ep = null;
  for (var j = 0; j < seasonEpisodes.length; j++) {
    var e = seasonEpisodes[j];
    var en = parseInt(e.episode_number || e.episodeNumber || e.number || (j + 1));
    if (en === eNum) { ep = e; break; }
  }
  if (!ep && seasonEpisodes.length >= eNum) ep = seasonEpisodes[eNum - 1];
  if (!ep) return Promise.resolve([]);

  return getPlayerStreams(ep.id);
}

function getPlayerStreams(episodeId) {
  return utils.fetchWithTimeout(API + "shows/episodes/player/" + episodeId)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var streams = [];
      var seen = {};

      // ── استخراج الترجمات ─────────────────────────────────────
      var subtitles = extractCBSubtitles(data);

      // ── استخراج الروابط ──────────────────────────────────────
      var videos = data.videos || [];
      for (var i = 0; i < videos.length; i++) {
        var v = videos[i];
        if (!v.url || seen[v.url]) continue;
        seen[v.url] = true;
        var q = utils.normalizeQuality(v.quality || "HD");
        streams.push({ name: "CinemaBox", title: "CinemaBox " + q, url: v.url, quality: q, subtitles: subtitles });
      }

      // fallback: regex على الـ HTML/JSON
      if (streams.length === 0) {
        var text = JSON.stringify(data);
        var re = /(https?:\/\/cloud[0-9]*\.albox\.co\/episodes\/[^"'\s,\]]+\.mp4)/gi;
        var m;
        while ((m = re.exec(text)) !== null) {
          if (!seen[m[1]]) {
            seen[m[1]] = true;
            streams.push({ name: "CinemaBox", title: "CinemaBox HD", url: m[1], quality: "HD", subtitles: subtitles });
          }
        }
      }

      return utils.sortByQuality(streams);
    })
    .catch(function() { return []; });
}

/**
 * استخراج الترجمات من response الـ player
 * CinemaBox تُرجع مصفوفة subtitles أو tracks بجانب videos
 */
function extractCBSubtitles(data) {
  var subs = [];
  var seen = {};

  // الصيغة الشائعة: data.subtitles[]
  var rawSubs = data.subtitles || data.tracks || data.captions || [];
  for (var i = 0; i < rawSubs.length; i++) {
    var s = rawSubs[i];
    var url = s.url || s.file || s.src || "";
    var lang = s.language || s.lang || s.code || "ar";
    var label = s.label || s.name || (lang === "ar" ? "عربي" : lang);
    if (url && !seen[url]) {
      seen[url] = true;
      var sub = utils.makeSubtitle(url, lang, label);
      if (sub) subs.push(sub);
    }
  }

  // fallback: ابحث عن روابط .vtt أو .srt في الـ JSON
  if (subs.length === 0) {
    var text = JSON.stringify(data);
    var re = /(https?:\/\/[^"'\s]+\.(?:vtt|srt|ass))(?:\?[^"'\s]*)?/gi;
    var m;
    while ((m = re.exec(text)) !== null) {
      if (!seen[m[0]]) {
        seen[m[0]] = true;
        subs.push(utils.makeSubtitle(m[0], "ar", "عربي"));
      }
    }
  }

  return subs;
}

module.exports = { getStreams: getStreams };
