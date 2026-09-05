'use strict';

function parseMediaId(raw, type) {
  const value = decodeURIComponent(String(raw || '')).replace(/\.json$/i, '');
  const parts = value.split(':').filter(Boolean);
  const imdb = parts.find((part) => /^tt\d{5,12}$/i.test(part));
  const numeric = /^\d+$/.test(parts[0] || '')
    ? parts[0]
    : (/^tmdb$/i.test(parts[0] || '') && /^\d+$/.test(parts[1] || '') ? parts[1] : '');
  if (!numeric && !imdb) return null;
  let season;
  let episode;
  if (type === 'series' && parts.length >= 3) {
    const maybeEpisode = Number(parts[parts.length - 1]);
    const maybeSeason = Number(parts[parts.length - 2]);
    if (Number.isInteger(maybeSeason) && maybeSeason > 0 && Number.isInteger(maybeEpisode) && maybeEpisode > 0) {
      season = maybeSeason;
      episode = maybeEpisode;
    }
  }
  return { raw: value, tmdbId: numeric || '', imdbId: imdb || '', season, episode };
}

module.exports = { parseMediaId };
