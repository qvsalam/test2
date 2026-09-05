'use strict';

const DEFAULT_PROVIDER_HOSTS = [
  'movie.vodu.me',
  'isp.vodu.me',
  'cinema.albox.co',
  'pucinema.albox.co',
  'cinemana.shabakaty.com',
  'cinemana.shabakaty.cc',
  'api-cinema.shashety.com',
  'apitv.shashety.com',
  'cdn.shashety.com',
];

function asBoolean(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function asPositiveInt(value, fallback, minimum = 1) {
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum ? number : fallback;
}

function csv(value, fallback) {
  const values = String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return values.length ? values : [...fallback];
}

function normalizeRelayUrl(value) {
  if (!value) return '';
  const url = new URL(String(value).trim());
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('RELAY_URL must use http:// or https://');
  }
  if (url.username || url.password) {
    throw new Error('RELAY_URL must not contain credentials');
  }
  if (url.searchParams.has('token')) {
    throw new Error('Put the relay token in RELAY_TOKEN, not in RELAY_URL');
  }
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/relay';
  if (!url.pathname.endsWith('/relay')) {
    throw new Error('RELAY_URL must point to the relay /relay endpoint');
  }
  url.search = '';
  url.hash = '';
  return url.toString();
}

function readConfig(env = process.env) {
  const relayUrl = normalizeRelayUrl(env.RELAY_URL || env.RELAY_BASE_URL || '');
  const providerHosts = new Set(csv(env.PROVIDER_HOSTS, DEFAULT_PROVIDER_HOSTS));
  return {
    port: asPositiveInt(env.PORT, 7000, 1),
    publicBaseUrl: String(env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
    vlessUrl: String(env.VLESS_URL || ''),
    relayUrl,
    relayToken: String(env.RELAY_TOKEN || env.PROXY_TOKEN || ''),
    proxyToken: String(env.PROXY_TOKEN || env.RELAY_TOKEN || ''),
    tmdbApiKey: String(env.TMDB_API_KEY || ''),
    allowDirectProviderFetch: asBoolean(env.ALLOW_DIRECT_PROVIDER_FETCH, false),
    proxyStreams: asBoolean(env.PROXY_STREAMS, true),
    providerHosts,
    // Media URLs are commonly signed CDN URLs on a hostname that is different
    // from the provider API. With no STREAM_HOSTS value the HMAC-signed proxy
    // accepts any public HTTP(S) hostname; setting the variable restricts it.
    streamHosts: new Set(csv(env.STREAM_HOSTS, [])),
    providerTimeoutMs: asPositiveInt(env.PROVIDER_TIMEOUT_MS, 15000, 1000),
    relayTimeoutMs: asPositiveInt(env.RELAY_TIMEOUT_MS, 20000, 1000),
    maxResponseBytes: asPositiveInt(env.MAX_RESPONSE_BYTES, 64 * 1024 * 1024, 64 * 1024),
    maxPlaylistBytes: asPositiveInt(env.MAX_PLAYLIST_BYTES, 4 * 1024 * 1024, 64 * 1024),
    maxMetaSeasons: asPositiveInt(env.MAX_META_SEASONS, 3, 1),
    maxMetaEpisodes: asPositiveInt(env.MAX_META_EPISODES, 200, 1),
  };
}

function publicConfig(config) {
  return {
    vlessConfigured: Boolean(config.vlessUrl),
    relayConfigured: Boolean(config.relayUrl),
    proxyConfigured: Boolean(config.vlessUrl && config.proxyToken && config.proxyStreams),
    tmdbConfigured: Boolean(config.tmdbApiKey),
    providerHosts: [...config.providerHosts],
    streamHosts: config.streamHosts.size ? [...config.streamHosts] : ['*'],
    providerTimeoutMs: config.providerTimeoutMs,
  };
}

module.exports = {
  DEFAULT_PROVIDER_HOSTS,
  normalizeRelayUrl,
  publicConfig,
  readConfig,
};
