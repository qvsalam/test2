// ============================================================
// utils.js — مشترك بين كل المزودين
// ============================================================

var QUALITY_ORDER = { "1080p": 0, "1080": 0, "720p": 1, "720": 1, "480p": 2, "480": 2, "360p": 3, "360": 3, "240p": 4, "HLS": 5, "HD": 6 };

/**
 * جلب عناوين الفيلم/المسلسل من TMDB بالعربي والإنجليزي
 */
function fetchTMDBTitles(tmdbId, mediaType) {
  var path = "/" + (mediaType === "movie" ? "movie" : "tv") + "/" + tmdbId;
  var base = "https://api.themoviedb.org/3" + path + "?api_key=" + TMDB_API_KEY;

  return Promise.all([
    fetch(base + "&language=en").then(function(r) { return r.json(); }).catch(function() { return {}; }),
    fetch(base + "&language=ar").then(function(r) { return r.json(); }).catch(function() { return {}; })
  ]).then(function(results) {
    var en = results[0], ar = results[1];
    var titles = [];

    function add(t) { if (t && titles.indexOf(t) === -1) titles.push(t); }

    // عناوين إنجليزية
    add(en.title); add(en.original_title); add(en.name); add(en.original_name);
    // عناوين عربية — مهمة جداً للمنصات العراقية
    add(ar.title); add(ar.name);

    return titles.filter(Boolean);
  });
}

/**
 * fetch مع timeout (8 ثواني افتراضي)
 */
function fetchWithTimeout(url, ms) {
  ms = ms || 8000;
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, ms);
  return fetch(url, { signal: controller.signal })
    .then(function(r) { clearTimeout(timer); return r; })
    .catch(function(e) { clearTimeout(timer); throw e; });
}

/**
 * ترتيب الـ streams من أعلى جودة لأقل
 */
function sortByQuality(streams) {
  streams.sort(function(a, b) {
    var oa = QUALITY_ORDER[a.quality] != null ? QUALITY_ORDER[a.quality] : 9;
    var ob = QUALITY_ORDER[b.quality] != null ? QUALITY_ORDER[b.quality] : 9;
    return oa - ob;
  });
  return streams;
}

/**
 * تنظيف وتوحيد نص الجودة
 */
function normalizeQuality(q) {
  if (!q) return "HD";
  if (typeof q === "number") return q + "p";
  return String(q).replace(/\s/g, "");
}

/**
 * بناء كائن subtitle موحد
 * @param {string} url  رابط الترجمة
 * @param {string} lang كود اللغة (ar, en, ...)
 * @param {string} label اسم يظهر للمستخدم
 */
function makeSubtitle(url, lang, label) {
  if (!url) return null;
  var format = "vtt";
  if (/\.srt(\?|$)/i.test(url)) format = "srt";
  if (/\.ass(\?|$)/i.test(url)) format = "ass";
  return { url: url, language: lang || "ar", label: label || "عربي", format: format };
}

module.exports = { fetchTMDBTitles, fetchWithTimeout, sortByQuality, normalizeQuality, makeSubtitle };
