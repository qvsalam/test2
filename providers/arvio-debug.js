// ARVIO diagnostic provider - temporary compatibility probe
var FALLBACK_TMDB_KEY = "ee8ac8a9044c09a11cc362033f98c735";
var SAMPLE_URL = "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4";

function clip(value, max) {
  var text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  return text.length > max ? text.substring(0, max) : text;
}

function countMatches(text, regex) {
  var count = 0;
  var match;
  while ((match = regex.exec(text)) !== null) {
    count++;
    if (count >= 999) break;
  }
  return count;
}

async function probe(url, headers) {
  try {
    var response = await fetch(url, { headers: headers || {} });
    var text = await response.text();
    var json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return {
      ok: !!response.ok,
      status: Number(response.status || 0),
      length: String(text || "").length,
      text: String(text || ""),
      json: json,
      error: ""
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      length: 0,
      text: "",
      json: null,
      error: clip(error && (error.message || error), 55)
    };
  }
}

function arrayLength(value) {
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== "object") return 0;
  var keys = ["results", "data", "items", "posts", "shows", "result"];
  for (var i = 0; i < keys.length; i++) {
    if (Array.isArray(value[keys[i]])) return value[keys[i]].length;
  }
  return 0;
}

function diagnosticStream(label, details) {
  return {
    name: "ARVIO Debug",
    title: label + " | " + details,
    provider: "ARVIO Debug",
    url: SAMPLE_URL,
    quality: "TEST",
    type: "direct",
    language: "en"
  };
}

async function getStreams(tmdbId, mediaType, season, episode) {
  var type = String(mediaType || "").toLowerCase() === "movie" ? "movie" : "tv";
  var sourceType = type === "movie" ? "movies" : "series";
  var apiKey = (typeof globalThis !== "undefined" && globalThis.TMDB_API_KEY) || FALLBACK_TMDB_KEY;
  var tmdbUrl = "https://api.themoviedb.org/3/" + type + "/" + encodeURIComponent(tmdbId) + "?api_key=" + encodeURIComponent(apiKey) + "&language=en";
  var tmdb = await probe(tmdbUrl, { Accept: "application/json" });
  var title = "";
  if (tmdb.json) {
    title = tmdb.json.title || tmdb.json.name || tmdb.json.original_title || tmdb.json.original_name || "";
  }

  var results = [];
  var tmdbDetails = "HTTP " + tmdb.status + ", " + tmdb.length + " chars";
  if (title) tmdbDetails += ", title=" + clip(title, 32);
  if (tmdb.error) tmdbDetails += ", error=" + tmdb.error;
  results.push(diagnosticStream("TMDB", tmdbDetails));

  if (!title) {
    results.push(diagnosticStream("VODU", "SKIPPED: TMDB title missing"));
    results.push(diagnosticStream("Cinemana", "SKIPPED: TMDB title missing"));
    results.push(diagnosticStream("CinemaBox", "SKIPPED: TMDB title missing"));
    return results;
  }

  var encodedTitle = encodeURIComponent(title);

  var vodu = await probe(
    "https://movie.vodu.me/index.php?do=list&title=" + encodedTitle,
    { Accept: "text/html,*/*", "User-Agent": "Mozilla/5.0" }
  );
  var voduHits = countMatches(vodu.text, /do=view/gi);
  var voduDetails = "HTTP " + vodu.status + ", " + vodu.length + " chars, viewHits=" + voduHits;
  if (vodu.length >= 262000) voduDetails += ", POSSIBLY TRUNCATED";
  if (vodu.error) voduDetails += ", error=" + vodu.error;
  results.push(diagnosticStream("VODU", voduDetails));

  var cinemana = await probe(
    "https://cinemana.shabakaty.com/api/android/AdvancedSearch?level=1&page=0&videoTitle=" + encodedTitle + "&type=" + sourceType,
    { Accept: "application/json", "User-Agent": "Mozilla/5.0" }
  );
  var cinemanaDetails = "HTTP " + cinemana.status + ", " + cinemana.length + " chars, items=" + arrayLength(cinemana.json);
  if (cinemana.length >= 262000) cinemanaDetails += ", POSSIBLY TRUNCATED";
  if (!cinemana.json && cinemana.length) cinemanaDetails += ", JSON INVALID";
  if (cinemana.error) cinemanaDetails += ", error=" + cinemana.error;
  results.push(diagnosticStream("Cinemana", cinemanaDetails));

  var cinemaBox = await probe(
    "https://cinema.albox.co/api/v4/shows/search?q=" + encodedTitle,
    { Accept: "application/json, text/plain, */*", "User-Agent": "Mozilla/5.0" }
  );
  var cinemaBoxDetails = "HTTP " + cinemaBox.status + ", " + cinemaBox.length + " chars, items=" + arrayLength(cinemaBox.json);
  if (cinemaBox.length >= 262000) cinemaBoxDetails += ", POSSIBLY TRUNCATED";
  if (!cinemaBox.json && cinemaBox.length) cinemaBoxDetails += ", JSON INVALID";
  if (cinemaBox.error) cinemaBoxDetails += ", error=" + cinemaBox.error;
  results.push(diagnosticStream("CinemaBox", cinemaBoxDetails));

  return results;
}

module.exports = { getStreams: getStreams };
