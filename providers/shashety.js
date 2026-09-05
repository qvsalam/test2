'use strict';
const API = 'https://api-cinema.shashety.com/api/v1/';
const KEY = 'ee8ac8a9044c09a11cc362033f98c735';
const normalize = s => String(s || '').toLowerCase().replace(/[\u064b-\u065f]/g, '').replace(/[^a-z0-9\u0600-\u06ff]/g, '');
async function json(url) { const r = await fetch(url); if (!r.ok) throw new Error('Upstream HTTP ' + r.status); return r.json(); }
async function getStreams(id, type, season, episode) {
  try {
    const movie = type === 'movie';
    if (!movie && (!Number.isInteger(Number(season)) || Number(season) < 1 || !Number.isInteger(Number(episode)) || Number(episode) < 1)) return [];
    const meta = await json('https://api.themoviedb.org/3/' + (movie ? 'movie/' : 'tv/') + encodeURIComponent(id) + '?api_key=' + KEY + '&language=en');
    const titles = [...new Set([meta.title, meta.name, meta.original_title, meta.original_name].filter(Boolean))];
    const year = Number(String(meta.release_date || meta.first_air_date || '').slice(0, 4));
    let match;
    for (const title of titles.slice(0, 3)) {
      const result = await json(API + 'search?name=' + encodeURIComponent(title));
      match = (result.items || []).find(item => item.type === (movie ? 'movie' : 'series') && (!year || !item.year || Math.abs(Number(item.year) - year) <= 1) && [item.name, item.en_name].some(n => titles.some(t => normalize(t) === normalize(n))));
      if (match) break;
    }
    if (!match) return [];
    const seriesId = match.series_id || match.id;
    const result = await json(API + (movie ? 'movie/' + match.id : 'seasons/' + Number(season) + '/series/' + seriesId + '/episode/' + Number(episode)));
    const detail = movie ? result : (Array.isArray(result) ? result : []).find(x => Number(x.season_number) === Number(season) && Number(x.episode_number) === Number(episode) && Number(x.series_id) === Number(seriesId));
    if (!detail) return [];
    const subtitles = (detail.subtitle_v2 || []).map(s => ({url: s.subtitle || s.subtitle_cast, lang: /arabic/i.test(s.language) ? 'ar' : /english/i.test(s.language) ? 'en' : s.language || 'und'})).filter(s => /^https?:\/\//i.test(s.url));
    const seen = new Set();
    return (detail.video_v2 || []).map(v => {
      const quality = String(v.new_resolution || v.resolution || 'HD');
      return {name:'Shashety', provider:'Shashety', title:'Shashety ' + quality, quality, url:v.full_url || v.video_url, subtitles, type:'direct'};
    }).filter(s => { if (!/^https?:\/\//i.test(s.url) || seen.has(s.url)) return false; seen.add(s.url); return true; }).sort((a,b) => (/4k/i.test(b.quality) ? 2160 : parseInt(b.quality) || 0) - (/4k/i.test(a.quality) ? 2160 : parseInt(a.quality) || 0));
  } catch (_) { return []; }
}
module.exports = {getStreams};
