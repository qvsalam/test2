// CinemaBox Provider — Iraq Scrapers v4.5.0
// ARVIO/Nuvio local JS scraper. Requests run from the user's device/IP.

var TMDB_KEY = "ee8ac8a9044c09a11cc362033f98c735";
var API = "https://cinema.albox.co/api/v4/";
var QUALITY_ORDER = { "2160p": 0, "4K": 0, "1080p": 1, "720p": 2, "480p": 3, "360p": 4, "240p": 5, "HLS": 6, "HD": 7 };

function normalizeType(mediaType) {
  mediaType = String(mediaType || "").toLowerCase();
  return mediaType === "movie" ? "movie" : "tv";
}

function normalizeQuality(q, url) {
  var raw = String(q || "").trim();
  var text = (raw + " " + (url || "")).toLowerCase();
  if (/2160p|4k|uhd/.test(text)) return "4K";
  if (/1080p|1080/.test(text)) return "1080p";
  if (/720p|720/.test(text)) return "720p";
  if (/480p|480/.test(text)) return "480p";
  if (/360p|360/.test(text)) return "360p";
  if (/240p|240/.test(text)) return "240p";
  if (/\.m3u8|hls/.test(text)) return "HLS";
  if (raw && /^[0-9]{3,4}$/.test(raw)) return raw + "p";
  return raw || "HD";
}

function sortByQuality(streams) {
  return streams.sort(function(a, b) {
    var oa = QUALITY_ORDER[a.quality] != null ? QUALITY_ORDER[a.quality] : 99;
    var ob = QUALITY_ORDER[b.quality] != null ? QUALITY_ORDER[b.quality] : 99;
    return oa - ob;
  });
}

function norm(s) {
  return String(s || "").toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^a-z0-9\u0600-\u06FF\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function similarity(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.indexOf(b) > -1 || b.indexOf(a) > -1) return 0.86;
  var aa = a.split(" "), bb = b.split(" ");
  var common = 0;
  for (var i = 0; i < aa.length; i++) {
    for (var j = 0; j < bb.length; j++) {
      if (aa[i].length > 1 && aa[i] === bb[j]) { common++; break; }
    }
  }
  return (2 * common) / (aa.length + bb.length);
}

function bestScore(titles, target) {
  var best = 0;
  for (var i = 0; i < titles.length; i++) {
    var s = similarity(titles[i], target);
    if (s > best) best = s;
  }
  return best;
}

function addUnique(arr, value) {
  if (value && arr.indexOf(value) === -1) arr.push(value);
}

async function fetchJson(url) {
  var res = await fetch(url, {
    headers: {
      "Accept": "application/json, text/plain, */*",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    }
  });
  if (!res || !res.ok) return null;
  return await res.json();
}

async function fetchTMDBData(tmdbId, mediaType) {
  var type = normalizeType(mediaType);
  var path = "/" + (type === "movie" ? "movie" : "tv") + "/" + tmdbId;
  var base = "https://api.themoviedb.org/3" + path + "?api_key=" + TMDB_KEY;
  var en = await fetchJson(base + "&language=en").catch(function() { return {}; }) || {};
  var ar = await fetchJson(base + "&language=ar").catch(function() { return {}; }) || {};
  var titles = [];
  addUnique(titles, en.title); addUnique(titles, en.original_title); addUnique(titles, en.name); addUnique(titles, en.original_name);
  addUnique(titles, ar.title); addUnique(titles, ar.original_title); addUnique(titles, ar.name); addUnique(titles, ar.original_name);
  var dateStr = en.release_date || en.first_air_date || ar.release_date || ar.first_air_date || "";
  var year = dateStr ? parseInt(String(dateStr).substring(0, 4), 10) : null;
  return { titles: titles.filter(Boolean), year: year };
}

function asArray(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.results)) return data.results;
  if (Array.isArray(data.data)) return data.data;
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.posts)) return data.posts;
  if (Array.isArray(data.shows)) return data.shows;
  if (data.result && Array.isArray(data.result)) return data.result;
  return [];
}

function itemTitle(item) {
  return item && (item.name || item.title || item.en_name || item.ar_name || item.original_name || item.post_title || item.show_name || "");
}

function itemYear(item) {
  var raw = item && (item.year || item.release_year || item.production_year || item.date || item.release_date || item.first_air_date || "");
  var m = String(raw).match(/(19|20)\d{2}/);
  return m ? parseInt(m[0], 10) : null;
}

function itemId(item) {
  return item && (item.id || item.show_id || item.post_id || item.nb || item._id || item.uuid || null);
}

function itemType(item) {
  var raw = String((item && (item.type || item.kind || item.category || item.post_type || item.media_type)) || "").toUpperCase();
  if (raw.indexOf("MOVIE") > -1 || raw.indexOf("FILM") > -1) return "MOVIE";
  if (raw.indexOf("SERIES") > -1 || raw.indexOf("SHOW") > -1 || raw.indexOf("TV") > -1) return "SERIES";
  return raw;
}

function pickBestMatch(results, titles, year, mediaType) {
  var targetType = normalizeType(mediaType) === "movie" ? "MOVIE" : "SERIES";
  var best = null, bestVal = -999;
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    var id = itemId(r);
    if (!id) continue;
    var t = itemType(r);
    var score = bestScore(titles, itemTitle(r));
    if (t && t !== targetType) score -= 0.55;
    if (year) {
      var ry = itemYear(r);
      if (ry === year) score += 0.35;
      else if (ry && Math.abs(ry - year) === 1) score += 0.12;
      else if (ry && Math.abs(ry - year) > 2) score -= 0.25;
    }
    if (score > bestVal) { bestVal = score; best = r; }
  }
  if (best && bestVal >= 0.35) return best;

  // Last safe fallback: same type with an id, otherwise first item with id.
  for (var j = 0; j < results.length; j++) {
    if (itemId(results[j]) && itemType(results[j]) === targetType) return results[j];
  }
  for (var k = 0; k < results.length; k++) {
    if (itemId(results[k])) return results[k];
  }
  return null;
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    var data = await fetchTMDBData(tmdbId, mediaType);
    if (!data.titles.length) return [];
    for (var i = 0; i < data.titles.length; i++) {
      var streams = await searchCB(data.titles[i], data.titles, data.year, mediaType, season, episode);
      if (streams.length) return streams;
    }
    return [];
  } catch (e) {
    return [];
  }
}

async function searchCB(query, titles, year, mediaType, season, episode) {
  var searchUrls = [
    API + "search?q=" + encodeURIComponent(query),
    API + "search?keyword=" + encodeURIComponent(query),
    API + "shows/search?q=" + encodeURIComponent(query)
  ];

  for (var u = 0; u < searchUrls.length; u++) {
    var data = await fetchJson(searchUrls[u]).catch(function() { return null; });
    var results = asArray(data);
    if (!results.length) continue;

    var match = pickBestMatch(results, titles, year, mediaType);
    if (!match) continue;
    var id = itemId(match);
    if (!id) continue;

    var detail = await fetchDetail(id);
    if (!detail) continue;

    if (normalizeType(mediaType) === "movie") {
      var epId = getMovieEpisodeId(detail);
      var movieStreams = epId ? await getPlayerStreams(epId) : extractStreamsFromAny(detail, "CinemaBox");
      if (movieStreams.length) return movieStreams;
    } else {
      var tvStreams = await getTVStreams(detail, parseInt(season, 10) || 1, parseInt(episode, 10) || 1);
      if (tvStreams.length) return tvStreams;
    }
  }
  return [];
}

async function fetchDetail(id) {
  var urls = [
    API + "shows/shows/dynamic/" + id,
    API + "shows/show/" + id,
    API + "show/" + id
  ];
  for (var i = 0; i < urls.length; i++) {
    var d = await fetchJson(urls[i]).catch(function() { return null; });
    if (!d) continue;
    if (d.data && !Array.isArray(d.data)) d = d.data;
    if (d.result && !Array.isArray(d.result)) d = d.result;
    if (d.post_info || d.sections || d.seasons || d.episodes || d.videos || d.data) return d;
  }
  return null;
}

function getMovieEpisodeId(detail) {
  var p = detail.post_info || detail.postInfo || detail.info || detail;
  return p.episode_id || p.episodeId || p.episode || p.default_episode_id || p.defaultEpisodeId || p.id || null;
}

function collectEpisodeObjects(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (var i = 0; i < node.length; i++) collectEpisodeObjects(node[i], out);
    return;
  }
  var id = node.id || node.episode_id || node.episodeId || node.nb;
  var en = node.episode_number || node.episodeNumber || node.number || node.episode || node.ep_num;
  var sn = node.season_number || node.seasonNumber || node.season || node.season_num;
  var card = String(node.card_type || node.type || "").toLowerCase();
  if (id && (en || card.indexOf("episode") > -1)) out.push(node);
  var keys = Object.keys(node);
  for (var k = 0; k < keys.length; k++) collectEpisodeObjects(node[keys[k]], out);
}

async function getTVStreams(detail, sNum, eNum) {
  var episodes = [];
  collectEpisodeObjects(detail, episodes);
  var ep = null;
  for (var i = 0; i < episodes.length; i++) {
    var item = episodes[i];
    var sn = parseInt(item.season_number || item.seasonNumber || item.season || item.season_num || sNum, 10) || sNum;
    var en = parseInt(item.episode_number || item.episodeNumber || item.number || item.episode || item.ep_num || (i + 1), 10);
    if (sn === sNum && en === eNum) { ep = item; break; }
  }
  if (!ep && episodes.length >= eNum) ep = episodes[eNum - 1];
  if (!ep) {
    var fallbackId = detail.post_info && detail.post_info.episode_id;
    return fallbackId ? getPlayerStreams(fallbackId) : [];
  }
  var direct = extractStreamsFromAny(ep, "CinemaBox");
  if (direct.length) return direct;
  var epId = ep.id || ep.episode_id || ep.episodeId || ep.nb;
  return epId ? getPlayerStreams(epId) : [];
}

function collectUrls(node, out) {
  if (node == null) return;
  if (typeof node === "string") {
    var text = node.replace(/\\\//g, "/").replace(/&amp;/g, "&");
    var re = /https?:\/\/[^\s"'<>\\]+(?:\.mp4|\.m3u8)(?:\?[^\s"'<>\\]*)?/gi;
    var m;
    while ((m = re.exec(text)) !== null) out.push(m[0]);
    return;
  }
  if (Array.isArray(node)) {
    for (var i = 0; i < node.length; i++) collectUrls(node[i], out);
    return;
  }
  if (typeof node === "object") {
    var keys = Object.keys(node);
    for (var k = 0; k < keys.length; k++) collectUrls(node[keys[k]], out);
  }
}

function extractStreamsFromAny(data, providerName) {
  var urls = [];
  collectUrls(data, urls);
  var streams = [], seen = {};
  for (var i = 0; i < urls.length; i++) {
    var url = urls[i];
    if (!url || seen[url] || /trailer|thumb|poster|preview/i.test(url)) continue;
    seen[url] = true;
    var q = normalizeQuality("", url);
    streams.push({ title: providerName + " " + q, name: providerName, provider: providerName, url: url, quality: q, type: url.indexOf(".m3u8") > -1 ? "hls" : "direct" });
  }
  return sortByQuality(streams);
}

async function getPlayerStreams(episodeId) {
  var urls = [
    API + "shows/episodes/player/" + episodeId,
    API + "episodes/player/" + episodeId,
    API + "player/" + episodeId
  ];
  for (var i = 0; i < urls.length; i++) {
    var data = await fetchJson(urls[i]).catch(function() { return null; });
    if (!data) continue;
    var streams = [], seen = {};
    var candidates = [];
    collectVideoObjects(data, candidates);
    for (var c = 0; c < candidates.length; c++) {
      var v = candidates[c];
      var url = v.url || v.videoUrl || v.video_url || v.file || v.src || v.link || v.hls || v.mp4 || "";
      if (!url || seen[url]) continue;
      seen[url] = true;
      var q = normalizeQuality(v.quality || v.resolution || v.label || v.name, url);
      streams.push({ title: "CinemaBox " + q, name: "CinemaBox", provider: "CinemaBox", url: url, quality: q, type: url.indexOf(".m3u8") > -1 ? "hls" : "direct" });
    }
    var extra = extractStreamsFromAny(data, "CinemaBox");
    for (var e = 0; e < extra.length; e++) {
      if (!seen[extra[e].url]) { seen[extra[e].url] = true; streams.push(extra[e]); }
    }
    if (streams.length) return sortByQuality(streams);
  }
  return [];
}

function collectVideoObjects(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (var i = 0; i < node.length; i++) collectVideoObjects(node[i], out);
    return;
  }
  if (node.url || node.videoUrl || node.video_url || node.file || node.src || node.link || node.hls || node.mp4) out.push(node);
  var keys = Object.keys(node);
  for (var k = 0; k < keys.length; k++) collectVideoObjects(node[keys[k]], out);
}

module.exports = { getStreams: getStreams };
