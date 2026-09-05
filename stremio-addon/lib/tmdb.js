'use strict';

const API_ROOT = 'https://api.themoviedb.org/3';
const IMAGE_ROOT = 'https://image.tmdb.org/t/p/w500';
const { parseMediaId } = require('./ids');

function image(pathname) {
  return pathname ? `${IMAGE_ROOT}${pathname}` : undefined;
}

function yearOf(item) {
  const date = item.release_date || item.first_air_date || '';
  return date ? Number(String(date).slice(0, 4)) || undefined : undefined;
}

function tmdbId(raw) {
  return parseMediaId(raw, 'series')?.tmdbId || '';
}

function imdbId(raw) {
  return parseMediaId(raw, 'series')?.imdbId || '';
}

class TmdbClient {
  constructor({ apiKey, fetchImpl = globalThis.fetch, maxMetaSeasons = 100, maxMetaEpisodes = 5000 }) {
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.maxMetaSeasons = maxMetaSeasons;
    this.maxMetaEpisodes = maxMetaEpisodes;
  }

  async request(pathname, params = {}) {
    if (!this.apiKey) return null;
    const url = new URL(`${API_ROOT}${pathname}`);
    url.searchParams.set('api_key', this.apiKey);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    const response = await this.fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`TMDB HTTP ${response.status}`);
    return response.json();
  }

  async resolveId(type, rawId) {
    const numeric = tmdbId(rawId);
    if (numeric) return numeric;
    const imdb = imdbId(rawId);
    if (!imdb) return '';
    const data = await this.request(`/find/${imdb}`, { external_source: 'imdb_id', language: 'en' });
    const list = type === 'series' ? data?.tv_results : data?.movie_results;
    const first = Array.isArray(list) ? list[0] : null;
    return first?.id ? String(first.id) : '';
  }

  async catalog(type, search, page = 1) {
    const endpoint = search ? `/search/${type === 'series' ? 'tv' : 'movie'}` : `/trending/${type === 'series' ? 'tv' : 'movie'}/week`;
    const data = await this.request(endpoint, {
      query: search,
      page: Math.min(Math.max(Number(page) || 1, 1), 1000),
      language: 'ar',
      include_adult: 'false',
    });
    const items = Array.isArray(data?.results) ? data.results : [];
    return items.map((item) => ({
      id: `tmdb:${item.id}`,
      type,
      name: item.title || item.name || item.original_title || item.original_name || `TMDB ${item.id}`,
      poster: image(item.poster_path),
      background: image(item.backdrop_path),
      description: item.overview || undefined,
      year: yearOf(item),
      imdbRating: item.vote_average ? String(item.vote_average) : undefined,
      releaseInfo: yearOf(item) ? String(yearOf(item)) : undefined,
    }));
  }

  async meta(type, id) {
    const numericId = await this.resolveId(type, id);
    if (!numericId) return null;
    const item = await this.request(`/${type === 'series' ? 'tv' : 'movie'}/${numericId}`, {
      language: 'ar',
      append_to_response: 'external_ids',
    });
    if (!item) return null;

    const mediaId = imdbId(id) || `tmdb:${numericId}`;
    const meta = {
      id: mediaId,
      type,
      name: item.title || item.name || item.original_title || item.original_name || `TMDB ${numericId}`,
      poster: image(item.poster_path),
      background: image(item.backdrop_path),
      logo: undefined,
      description: item.overview || undefined,
      year: yearOf(item),
      imdbRating: item.vote_average ? String(item.vote_average) : undefined,
      releaseInfo: yearOf(item) ? String(yearOf(item)) : undefined,
      genres: Array.isArray(item.genres) ? item.genres.map((genre) => genre.name).filter(Boolean) : [],
      runtime: item.runtime ? `${item.runtime} min` : undefined,
      imdb_id: item.external_ids?.imdb_id || undefined,
      videos: [],
    };

    if (type !== 'series' || !Array.isArray(item.seasons)) return meta;
    const seasons = item.seasons
      .filter((season) => Number.isInteger(Number(season.season_number)) && Number(season.season_number) >= 0)
      .sort((a, b) => Number(a.season_number) - Number(b.season_number))
      .slice(0, this.maxMetaSeasons);
    let count = 0;
    // Bound concurrency while retaining later seasons in the Stremio episode list.
    for (let offset = 0; offset < seasons.length && count < this.maxMetaEpisodes; offset += 5) {
      const batch = seasons.slice(offset, offset + 5);
      const results = await Promise.all(batch.map(async (season) => {
        try { return await this.request(`/tv/${numericId}/season/${season.season_number}`, { language: 'ar' }); }
        catch (_) { return null; }
      }));
      for (let index = 0; index < results.length && count < this.maxMetaEpisodes; index += 1) {
        const season = batch[index];
        for (const episode of results[index]?.episodes || []) {
          if (count >= this.maxMetaEpisodes) break;
          meta.videos.push({
            id: `${mediaId}:${season.season_number}:${episode.episode_number}`,
            season: season.season_number,
            episode: episode.episode_number,
            title: episode.name || `Episode ${episode.episode_number}`,
            released: episode.air_date ? `${episode.air_date}T00:00:00.000Z` : undefined,
            overview: episode.overview || undefined,
            thumbnail: image(episode.still_path) || meta.background,
          });
          count += 1;
        }
      }
    }
    return meta;
  }
}

module.exports = { API_ROOT, IMAGE_ROOT, TmdbClient, image, tmdbId, yearOf };
