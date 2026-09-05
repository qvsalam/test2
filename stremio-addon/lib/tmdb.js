'use strict';

const API_ROOT = 'https://api.themoviedb.org/3';
const IMAGE_ROOT = 'https://image.tmdb.org/t/p/w500';

function image(pathname) {
  return pathname ? `${IMAGE_ROOT}${pathname}` : undefined;
}

function yearOf(item) {
  const date = item.release_date || item.first_air_date || '';
  return date ? Number(String(date).slice(0, 4)) || undefined : undefined;
}

function tmdbId(raw) {
  const match = String(raw || '').match(/(?:tmdb:)?(\d+)/i);
  return match ? match[1] : '';
}

function imdbId(raw) {
  const match = String(raw || '').match(/tt\d{5,12}/i);
  return match ? match[0].toLowerCase() : '';
}

class TmdbClient {
  constructor({ apiKey, fetchImpl = globalThis.fetch, maxMetaSeasons = 3, maxMetaEpisodes = 200 }) {
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
    const response = await this.fetch(url);
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
      imdbRating: item.vote_average || undefined,
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

    const meta = {
      id: `tmdb:${numericId}`,
      type,
      name: item.title || item.name || item.original_title || item.original_name || `TMDB ${numericId}`,
      poster: image(item.poster_path),
      background: image(item.backdrop_path),
      logo: undefined,
      description: item.overview || undefined,
      year: yearOf(item),
      imdbRating: item.vote_average || undefined,
      genres: Array.isArray(item.genres) ? item.genres.map((genre) => genre.name).filter(Boolean) : [],
      runtime: item.runtime || undefined,
      imdb_id: item.external_ids?.imdb_id || undefined,
      videos: [],
    };

    if (type !== 'series' || !Array.isArray(item.seasons)) return meta;
    const seasons = item.seasons
      .filter((season) => Number(season.season_number) > 0)
      .slice(0, this.maxMetaSeasons);
    let count = 0;
    for (const season of seasons) {
      let seasonData;
      try {
        seasonData = await this.request(`/tv/${numericId}/season/${season.season_number}`, { language: 'ar' });
      } catch (_) {
        continue;
      }
      for (const episode of seasonData?.episodes || []) {
        if (count >= this.maxMetaEpisodes) break;
        meta.videos.push({
          id: `tmdb:${numericId}:${season.season_number}:${episode.episode_number}`,
          season: season.season_number,
          episode: episode.episode_number,
          title: episode.name || `Episode ${episode.episode_number}`,
          released: episode.air_date ? `${episode.air_date}T00:00:00.000Z` : undefined,
          overview: episode.overview || undefined,
          thumbnail: image(episode.still_path) || meta.background,
        });
        count += 1;
      }
      if (count >= this.maxMetaEpisodes) break;
    }
    return meta;
  }
}

module.exports = { API_ROOT, IMAGE_ROOT, TmdbClient, image, tmdbId, yearOf };
