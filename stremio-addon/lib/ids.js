'use strict';

function parseMediaId(raw, type) {
  let value;
  try { value = decodeURIComponent(String(raw || '')).replace(/\.json$/i, ''); }
  catch (_) { return null; }
  const match = value.match(/^(?:(?:tmdb:)?([1-9]\d*)|(tt\d{5,12}))(?::(\d+):([1-9]\d*))?$/i);
  if (!match || (type !== 'series' && match[3] !== undefined)) return null;
  const season = match[3] === undefined ? undefined : Number(match[3]);
  const episode = match[4] === undefined ? undefined : Number(match[4]);
  if ((season !== undefined && !Number.isSafeInteger(season)) || (episode !== undefined && !Number.isSafeInteger(episode))) return null;
  return { raw: value, tmdbId: match[1] || '', imdbId: (match[2] || '').toLowerCase(), season, episode };
}

module.exports = { parseMediaId };
