'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { normalizeRelayUrl, publicConfig, readConfig } = require('../lib/config');
const { parseMediaId } = require('../lib/ids');
const { createProviderFetch } = require('../lib/relay-fetch');
const { createProviderRegistry } = require('../lib/provider-loader');
const { createApp, manifest, routeParts } = require('../server');
const { TmdbClient } = require('../lib/tmdb');
const { buildVlessHeader, maskedVlessConfig, parseVlessUrl, responseHeaders } = require('../lib/vless-client');

const repoProviders = path.resolve(process.env.PROVIDERS_DIR || path.join(__dirname, '..', '..', 'providers'));
const providerFiles = ['vodu-titlefix.js', 'cinemabox-apk.js', 'cinemana.js', 'shashety.js'];
const sourceProvidersPresent = providerFiles.every((filename) => fs.existsSync(path.join(repoProviders, filename)));

test('normalizes relay host to the exact /relay endpoint without secrets', () => {
  assert.equal(normalizeRelayUrl('https://relay.example.test'), 'https://relay.example.test/relay');
  assert.equal(normalizeRelayUrl('https://relay.example.test/relay'), 'https://relay.example.test/relay');
  assert.throws(() => normalizeRelayUrl('https://relay.example.test/proxy'), /\/relay/);
  assert.throws(() => normalizeRelayUrl('https://relay.example.test/relay?token=secret'), /RELAY_TOKEN/);
});

test('parses the supported VLESS WebSocket profile without exposing the UUID', () => {
  const value = parseVlessUrl('vless://123e4567-e89b-12d3-a456-426614174000@104.18.26.180:443?type=ws&security=tls&path=%2F&host=vless.example.test&sni=vless.example.test');
  assert.equal(value.type, 'ws');
  assert.equal(value.security, 'tls');
  assert.equal(value.path, '/');
  assert.equal(buildVlessHeader(value.uuid, 'example.com', 443).length, 34);
  const masked = JSON.stringify(maskedVlessConfig(value));
  assert.equal(masked.includes(value.uuid), false);
  assert.match(masked, /123e4567/);
});

test('parses Stremio movie and episode ids', () => {
  assert.deepEqual(parseMediaId('tmdb:27205', 'movie'), { raw: 'tmdb:27205', tmdbId: '27205', imdbId: '', season: undefined, episode: undefined });
  assert.deepEqual(parseMediaId('tmdb:1399:2:3', 'series'), { raw: 'tmdb:1399:2:3', tmdbId: '1399', imdbId: '', season: 2, episode: 3 });
  assert.deepEqual(parseMediaId('tt1234567:1:4', 'series'), { raw: 'tt1234567:1:4', tmdbId: '', imdbId: 'tt1234567', season: 1, episode: 4 });
  assert.equal(parseMediaId('tt1234567', 'movie').imdbId, 'tt1234567');
  assert.equal(parseMediaId('unknown', 'movie'), null);
});

test('manifest exposes Stremio resources and no relay configuration', () => {
  const value = manifest();
  assert.deepEqual(value.resources, ['catalog', 'meta', 'stream', 'subtitles']);
  assert.deepEqual(value.types, ['movie', 'series']);
  assert.deepEqual(value.idPrefixes, ['tmdb', 'tt']);
  assert.equal(JSON.stringify(value).includes('RELAY_TOKEN'), false);
  assert.equal(JSON.stringify(value).includes('VLESS_URL'), false);
});

test('route parser handles Stremio .json paths', () => {
  assert.deepEqual(routeParts('/stream/series/tmdb:1399:1:4.json'), {
    resource: 'stream', type: 'series', id: 'tmdb:1399:1:4',
  });
  assert.deepEqual(routeParts('/catalog/movie/iraq-movies.json'), {
    resource: 'catalog', type: 'movie', id: 'iraq-movies',
  });
  assert.equal(routeParts('/stream/movie/%E0%A4%A.json'), null);
});

test('provider fetch sends provider requests through relay and keeps token out of target URL', async () => {
  const calls = [];
  const baseFetch = async (input, options = {}) => {
    calls.push({ input: String(input), options });
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const config = readConfig({ RELAY_URL: 'https://relay.example.test', RELAY_TOKEN: 'secret', PROVIDER_HOSTS: 'movie.vodu.me' });
  const { providerFetch } = createProviderFetch({ config, baseFetch });
  await providerFetch('https://movie.vodu.me/index.php?do=list&title=Test', { headers: { Accept: 'text/html' } });
  assert.equal(calls.length, 1);
  assert.match(calls[0].input, /^https:\/\/relay\.example\.test\/relay\?url=/);
  assert.equal(new URL(calls[0].input).searchParams.get('token'), null);
  assert.equal(calls[0].options.headers.get('x-relay-token'), 'secret');
});

test('existing provider files load without modifying source files', { skip: !sourceProvidersPresent }, () => {
  for (const filename of providerFiles) assert.equal(fs.existsSync(path.join(repoProviders, filename)), true);
  const registry = createProviderRegistry({
    providerDir: repoProviders,
    fetchImpl: async () => new Response('[]', { status: 200 }),
  });
  assert.deepEqual(registry.health().loaded.sort(), ['cinemabox', 'cinemana', 'shashety', 'vodu']);
});

test('health status is deliberately redacted', () => {
  const config = readConfig({ RELAY_URL: 'https://relay.example.test/relay', RELAY_TOKEN: 'secret', TMDB_API_KEY: 'tmdb-secret' });
  const text = JSON.stringify(publicConfig(config));
  assert.equal(text.includes('secret'), false);
  assert.equal(text.includes('tmdb-secret'), false);
});

test('app returns a protocol-shaped catalog response when TMDB is not configured', async () => {
  const app = createApp({
    env: { PROVIDERS_DIR: repoProviders },
    providerDir: repoProviders,
    baseFetch: async () => new Response('{}', { status: 200 }),
  });
  const responses = [];
  const res = {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { responses.push(JSON.parse(Buffer.from(body || '{}').toString())); },
  };
  await app.handler({ method: 'GET', url: '/catalog/movie/iraq-movies.json', headers: { host: 'localhost' } }, res);
  assert.equal(res.status, 200);
  assert.deepEqual(responses[0], { metas: [] });
});

test('registry loads the checked-in providers', () => {
  const registry = createProviderRegistry({
    providerDir: repoProviders,
    fetchImpl: async () => new Response('[]', { status: 200 }),
  });
  assert.deepEqual(registry.health().loaded.sort(), ['cinemabox', 'cinemana', 'shashety', 'vodu']);
});

test('proxy requires a signature and hands the target to the VLESS streamer', async () => {
  const calls = [];
  const app = createApp({
    env: {
      VLESS_URL: 'vless://123e4567-e89b-12d3-a456-426614174000@104.18.26.180:443?type=ws&security=tls&host=vless.example.test&sni=vless.example.test',
      PROXY_TOKEN: 'proxy-secret',
      STREAM_HOSTS: 'cdn.example.test',
      PROVIDERS_DIR: repoProviders,
    },
    providerDir: repoProviders,
    baseFetch: async () => new Response('{}', { status: 200 }),
    streamer: async (vless, target, options, res) => {
      calls.push({ vless, target, options });
      res.writeHead(206, { 'content-type': 'video/mp4' });
      res.end(Buffer.from('ok'));
    },
  });
  const target = 'https://cdn.example.test/video.mp4';
  const sig = crypto.createHmac('sha256', 'proxy-secret').update(target).digest('base64url');
  const response = {
    headersSent: false,
    writableEnded: false,
    writeHead(status) { this.status = status; this.headersSent = true; },
    end() { this.writableEnded = true; },
  };
  await app.proxy({ method: 'GET', headers: { host: 'addon.example.test' }, socket: {} }, response,
    new URL(`http://addon.example.test/proxy?url=${encodeURIComponent(target)}&sig=${sig}`));
  assert.equal(response.status, 206);
  assert.equal(calls[0].target, target);
  assert.equal(JSON.stringify(calls[0]).includes('proxy-secret'), false);
});

test('proxy rejects hosts outside the explicit stream allow-list', async () => {
  const app = createApp({
    env: {
      VLESS_URL: 'vless://123e4567-e89b-12d3-a456-426614174000@104.18.26.180:443?type=ws&security=tls&host=vless.example.test&sni=vless.example.test',
      PROXY_TOKEN: 'proxy-secret',
      STREAM_HOSTS: 'cdn.allowed.test',
      PROVIDERS_DIR: repoProviders,
    },
    providerDir: repoProviders,
    baseFetch: async () => new Response('{}', { status: 200 }),
    streamer: async () => { throw new Error('must not connect'); },
  });
  const target = 'https://cdn.blocked.test/video.mp4';
  const sig = crypto.createHmac('sha256', 'proxy-secret').update(target).digest('base64url');
  const response = {
    headersSent: false,
    writableEnded: false,
    writeHead(status) { this.status = status; this.headersSent = true; },
    end() { this.writableEnded = true; },
  };
  await app.proxy({ method: 'GET', headers: { host: 'addon.example.test' }, socket: {} }, response,
    new URL(`http://addon.example.test/proxy?url=${encodeURIComponent(target)}&sig=${sig}`));
  assert.equal(response.status, 403);
});

test('stream endpoint does not return direct URLs when proxy configuration is incomplete', async () => {
  const app = createApp({
    env: { PROVIDERS_DIR: repoProviders },
    providerDir: repoProviders,
    baseFetch: async () => new Response('{}', { status: 200 }),
  });
  app.registry.getStreams = async () => [{ url: 'https://movie.vodu.me/video.mp4', provider: 'VODU' }];
  const response = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(Buffer.from(body).toString()); } };
  await app.handler({ method: 'GET', url: '/stream/movie/tmdb:1.json', headers: { host: 'localhost' } }, response);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { streams: [] });
});

test('stream endpoint omits media hosts outside STREAM_HOSTS instead of leaking direct URLs', async () => {
  const app = createApp({
    env: {
      VLESS_URL: 'vless://123e4567-e89b-12d3-a456-426614174000@104.18.26.180:443?type=ws&security=tls&host=vless.example.test&sni=vless.example.test',
      PROXY_TOKEN: 'proxy-secret',
      STREAM_HOSTS: 'cdn.allowed.test',
      PROVIDERS_DIR: repoProviders,
    },
    providerDir: repoProviders,
    baseFetch: async () => new Response('{}', { status: 200 }),
  });
  app.registry.getStreams = async () => [
    { url: 'https://cdn.blocked.test/video.mp4', provider: 'blocked' },
    { url: 'https://cdn.allowed.test/video.mp4', provider: 'allowed' },
  ];
  const response = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(Buffer.from(body).toString()); } };
  await app.handler({ method: 'GET', url: '/stream/movie/tmdb:1.json', headers: { host: 'addon.example.test' } }, response);
  assert.equal(response.status, 200);
  assert.equal(response.body.streams.length, 1);
  assert.match(response.body.streams[0].url, /\/proxy\?url=/);
});

test('stream response keeps redirect headers available for signed rewriting', () => {
  const headers = responseHeaders({ location: '/next.m3u8', 'content-type': 'application/vnd.apple.mpegurl' }, (value) => `signed:${value}`);
  assert.equal(headers.location, 'signed:/next.m3u8');
  assert.match(headers['access-control-expose-headers'], /location/);
});

function jsonResponse() {
  return {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = JSON.parse(Buffer.from(body).toString()); },
  };
}

test('catalog accepts Stremio path extras without corrupting escaped separators', async () => {
  const calls = [];
  const app = createApp({
    env: { TMDB_API_KEY: 'test-key' },
    providerDir: repoProviders,
    baseFetch: async (input) => { calls.push(new URL(input)); return new Response('{"results":[]}'); },
  });
  const response = jsonResponse();
  await app.handler({ method: 'GET', url: '/catalog/movie/iraq-movies/search=Tom%20%26%20Jerry%2F%D8%AA%D9%88%D9%85&skip=40.json', headers: { host: 'addon.test' } }, response);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { metas: [] });
  assert.equal(calls[0].pathname, '/3/search/movie');
  assert.equal(calls[0].searchParams.get('query'), 'Tom & Jerry/توم');
  assert.equal(calls[0].searchParams.get('page'), '3');
  assert.equal(routeParts('/catalog/movie/iraq-movies/search=%E0%A4%A.json'), null);
});

test('invalid URL and media ids return controlled empty/error responses', async () => {
  assert.equal(parseMediaId('%E0%A4%A', 'movie'), null);
  assert.equal(parseMediaId('tmdb:1399:2', 'series'), null);
  assert.equal(parseMediaId('prefix:tt1234567:1:4', 'series'), null);
  const app = createApp({ env: {}, providerDir: repoProviders });
  const response = jsonResponse();
  await app.handler({ method: 'GET', url: 'http://[invalid', headers: {} }, response);
  assert.equal(response.status, 400);
});

test('IMDb ids resolve through TMDB external find instead of being mistaken for numeric ids', async () => {
  const calls = [];
  const client = new TmdbClient({ apiKey: 'test-key', fetchImpl: async (input) => {
    calls.push(new URL(input));
    return new Response('{"movie_results":[{"id":27205}],"tv_results":[{"id":1399}]}');
  } });
  assert.equal(await client.resolveId('movie', 'tt1375666'), '27205');
  assert.equal(calls[0].pathname, '/3/find/tt1375666');
  assert.equal(calls[0].searchParams.get('external_source'), 'imdb_id');
  assert.equal(await client.resolveId('series', 'tmdb:1399:7:1'), '1399');
  assert.equal(calls.length, 1);
});

test('series metadata includes later seasons and retains IMDb video identity', async () => {
  let concurrent = 0;
  let maximum = 0;
  const client = new TmdbClient({ apiKey: 'test-key', fetchImpl: async (input) => {
    const pathname = new URL(input).pathname;
    if (pathname.includes('/find/')) return new Response('{"tv_results":[{"id":1399}]}');
    if (pathname.endsWith('/tv/1399')) return new Response(JSON.stringify({ name: 'Example', seasons: Array.from({ length: 8 }, (_, i) => ({ season_number: i + 1 })) }));
    const season = Number(pathname.split('/').at(-1));
    concurrent += 1;
    maximum = Math.max(maximum, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 1));
    concurrent -= 1;
    return new Response(JSON.stringify({ episodes: [{ episode_number: 1, name: `Season ${season}` }] }));
  } });
  const meta = await client.meta('series', 'tt0944947');
  assert.equal(meta.id, 'tt0944947');
  assert.equal(meta.videos.length, 8);
  assert.equal(meta.videos[7].id, 'tt0944947:8:1');
  assert.ok(maximum <= 5 && maximum > 1);
});

test('stream and subtitles resources return standard signed subtitles and remove custom direct fields', async () => {
  const app = createApp({
    env: { VLESS_URL: 'configured-for-mock-streamer', PROXY_TOKEN: 'test-secret' },
    providerDir: repoProviders,
  });
  const target = 'https://cnth2.shabakaty.cc/subtitle.vtt';
  app.registry.getStreams = async () => [{
    url: 'https://cdn.shabakaty.cc/video.mp4',
    subtitles: [{ url: target, lang: 'ar' }, { url: 'https://unrelated.test/subtitle.vtt', lang: 'en' }],
    tracks: [{ file: target, srclang: 'ar', kind: 'subtitles' }],
    subtitle: target,
    subUrl: target,
  }];
  const req = { method: 'GET', headers: { host: 'addon.example.test', 'x-forwarded-proto': 'https' }, url: '/stream/series/tmdb:1399:4:1.json' };
  const streamResponse = jsonResponse();
  await app.handler(req, streamResponse);
  const stream = streamResponse.body.streams[0];
  assert.equal(stream.subtitles.length, 1);
  assert.equal(stream.subtitles[0].lang, 'ara');
  assert.ok(stream.subtitles[0].id);
  assert.equal(stream.tracks, undefined);
  assert.equal(stream.subtitle, undefined);
  assert.equal(stream.subUrl, undefined);
  const signed = new URL(stream.subtitles[0].url);
  assert.equal(signed.origin, 'https://addon.example.test');
  assert.equal(signed.searchParams.get('url'), target);
  assert.equal(signed.searchParams.get('sig'), crypto.createHmac('sha256', 'test-secret').update(target).digest('base64url'));
  const subtitleResponse = jsonResponse();
  await app.handler({ ...req, url: '/subtitles/series/filehash/videoID=tmdb%3A1399%3A4%3A1.json' }, subtitleResponse);
  assert.deepEqual(subtitleResponse.body.subtitles, stream.subtitles);
  const health = JSON.stringify(app.health());
  assert.equal(health.includes('configured-for-mock-streamer'), false);
  assert.equal(health.includes('test-secret'), false);
});

test('default CDN suffix allow-list rejects lookalike and arbitrary domains', async () => {
  const app = createApp({ env: { VLESS_URL: 'configured', PROXY_TOKEN: 'secret' }, providerDir: repoProviders });
  app.registry.getStreams = async () => [
    { url: 'https://cdn.shabakaty.cc/video.mp4' },
    { url: 'https://shabakaty.cc.evil.test/video.mp4' },
    { url: 'https://evilshabakaty.cc/video.mp4' },
    { url: 'https://127.0.0.1/video.mp4' },
  ];
  const response = jsonResponse();
  await app.handler({ method: 'GET', url: '/stream/movie/tmdb:1.json', headers: { host: 'addon.test' } }, response);
  assert.equal(response.body.streams.length, 1);
});
