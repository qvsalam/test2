'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const { publicConfig, readConfig } = require('./lib/config');
const { parseMediaId } = require('./lib/ids');
const { createProviderFetch } = require('./lib/relay-fetch');
const { createProviderRegistry } = require('./lib/provider-loader');
const { TmdbClient } = require('./lib/tmdb');
const { maskedVlessConfig, parseVlessUrl, streamViaVless } = require('./lib/vless-client');

const DEFAULT_PROVIDER_DIR = path.resolve(__dirname, '..', 'providers');

function manifest() {
  return {
    id: 'com.qvsalam.iraq-scrapers.stremio',
    version: '0.1.0',
    name: 'Iraq Scrapers',
    description: 'Arabic movie and series streams from the configured provider relay.',
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tmdb', 'tt'],
    catalogs: [
      {
        type: 'movie',
        id: 'iraq-movies',
        name: 'Iraq Movies',
        extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }],
      },
      {
        type: 'series',
        id: 'iraq-series',
        name: 'Iraq Series',
        extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }],
      },
    ],
  };
}

function json(res, status, body) {
  const payload = status === 204 ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(payload);
}

function routeParts(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length < 1) return null;
  const resource = parts[0];
  if (resource === 'manifest.json' || resource === 'manifest') return { resource: 'manifest' };
  if (!['catalog', 'meta', 'stream'].includes(resource) || parts.length < 3) return null;
  let id;
  try { id = decodeURIComponent(parts.slice(2).join('/')); } catch (_) { return null; }
  return {
    resource,
    type: parts[1] === 'tv' ? 'series' : parts[1],
    id: id.replace(/\.json$/i, ''),
  };
}

function requestOrigin(req, config) {
  if (config.publicBaseUrl) return config.publicBaseUrl.replace(/\/$/, '');
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwarded || (req.socket && req.socket.encrypted ? 'https' : 'http');
  const host = String(req.headers.host || 'localhost').replace(/[\r\n]/g, '');
  return `${protocol}://${host}`;
}

function proxySignature(target, secret) {
  return crypto.createHmac('sha256', secret).update(target).digest('base64url');
}

function signaturesEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function streamHostAllowed(target, config) {
  try {
    const url = target instanceof URL ? target : new URL(target);
    const hostname = url.hostname.toLowerCase();
    if (config.streamHosts.size && !config.streamHosts.has('*') && !config.streamHosts.has(hostname)) return false;
    // Do not turn the signed proxy into a path to local services. CDN URLs
    // remain allowed by default, while loopback/link-local/private literals
    // are rejected before the VLESS tunnel is opened.
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) return false;
    const ipv4 = hostname.match(/^\d{1,3}(?:\.\d{1,3}){3}$/);
    if (ipv4) {
      const octets = hostname.split('.').map(Number);
      if (octets.some((value) => value > 255)) return false;
      const [a, b] = octets;
      if (a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false;
    }
    return true;
  } catch (_) {
    return false;
  }
}

function signedProxyUrl(target, req, config) {
  if (!config.proxyStreams || !config.proxyToken || !config.vlessUrl) return target;
  const url = new URL(target);
  if (!streamHostAllowed(url, config)) return target;
  const signature = proxySignature(url.toString(), config.proxyToken);
  return `${requestOrigin(req, config)}/proxy?url=${encodeURIComponent(url.toString())}&sig=${encodeURIComponent(signature)}`;
}

function incomingStreamHeaders(req) {
  const headers = {};
  for (const key of ['range', 'user-agent', 'accept', 'accept-language', 'referer', 'origin', 'if-none-match', 'if-modified-since', 'if-range']) {
    if (req.headers[key]) headers[key] = String(req.headers[key]);
  }
  return headers;
}

function rewritePlaylist(text, baseUrl, req, config) {
  const rewrite = (value) => {
    const trimmed = String(value || '').trim();
    if (!trimmed || trimmed.startsWith('#')) return value;
    try { return signedProxyUrl(new URL(trimmed, baseUrl).toString(), req, config); } catch (_) { return value; }
  };
  return String(text || '').split(/\r?\n/).map((line) => {
    if (/^\s*#/.test(line)) {
      return line.replace(/URI="([^"]+)"/gi, (_match, value) => `URI="${rewrite(value)}"`);
    }
    return line.trim() ? rewrite(line) : line;
  }).join('\n');
}

function createApp({ env = process.env, providerDir = env.PROVIDERS_DIR || DEFAULT_PROVIDER_DIR, baseFetch = globalThis.fetch, streamer = streamViaVless } = {}) {
  const config = readConfig(env);
  const { providerFetch } = createProviderFetch({ config, baseFetch });
  const registry = createProviderRegistry({
    providerDir,
    fetchImpl: providerFetch,
    timeoutMs: config.providerTimeoutMs,
  });
  const tmdb = new TmdbClient({
    apiKey: config.tmdbApiKey,
    fetchImpl: baseFetch,
    maxMetaSeasons: config.maxMetaSeasons,
    maxMetaEpisodes: config.maxMetaEpisodes,
  });

  async function handle(req, res) {
    if (req.method === 'OPTIONS') return json(res, 204, {});
    if (req.method !== 'GET') return json(res, 405, { error: 'Only GET and OPTIONS are supported' });

    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const route = routeParts(requestUrl.pathname);
    if (!route) return json(res, 404, { error: 'Not found' });

    try {
      if (route.resource === 'manifest') return json(res, 200, manifest());
      if (!['movie', 'series'].includes(route.type)) return json(res, 400, { error: 'Unsupported type' });

      if (route.resource === 'catalog') {
        const search = requestUrl.searchParams.get('search') || '';
        const skip = Number(requestUrl.searchParams.get('skip') || 0);
        const page = Math.floor(Math.max(skip, 0) / 20) + 1;
        const metas = (await tmdb.catalog(route.type, search, page)) || [];
        return json(res, 200, { metas });
      }

      if (route.resource === 'meta') {
        const meta = await tmdb.meta(route.type, route.id);
        return json(res, 200, { meta: meta || { id: route.id, type: route.type, name: route.id, videos: [] } });
      }

      const parsed = parseMediaId(route.id, route.type);
      if (!parsed) return json(res, 200, { streams: [] });
      const resolvedId = parsed.tmdbId || await tmdb.resolveId(route.type, parsed.imdbId);
      if (!resolvedId) return json(res, 200, { streams: [] });
      const streams = await registry.getStreams(resolvedId, route.type, parsed.season, parsed.episode);
      // Do not leak direct provider URLs when stream proxying is enabled but
      // its credentials/configuration are missing.
      if (config.proxyStreams && (!config.vlessUrl || !config.proxyToken)) {
        return json(res, 200, { streams: [] });
      }
      return json(res, 200, {
        streams: streams.map((stream) => {
          if (config.proxyStreams && !streamHostAllowed(stream.url, config)) return null;
          return {
            ...stream,
            url: signedProxyUrl(stream.url, req, config),
            name: stream.name || stream.provider || 'Iraq Scrapers',
            title: stream.title || stream.quality || 'Stream',
            behaviorHints: stream.behaviorHints || {},
          };
        }).filter(Boolean),
      });
    } catch (_) {
      // Stremio expects protocol-shaped responses. Keep implementation details
      // and relay credentials out of public error responses.
      if (route.resource === 'catalog') return json(res, 200, { metas: [] });
      if (route.resource === 'meta') return json(res, 200, { meta: null });
      if (route.resource === 'stream') return json(res, 200, { streams: [] });
      return json(res, 500, { error: 'Internal error' });
    }
  }

  async function handleProxy(req, res, requestUrl) {
    if (req.method === 'OPTIONS') return json(res, 204, {});
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 405, { error: 'Only GET and HEAD are supported' });
    }
    if (!config.vlessUrl) return json(res, 503, { error: 'VLESS_URL is not configured' });
    if (!config.proxyToken) return json(res, 503, { error: 'PROXY_TOKEN is not configured' });
    if (!config.proxyStreams) return json(res, 503, { error: 'Stream proxy is disabled' });

    const targetText = requestUrl.searchParams.get('url') || '';
    const signature = requestUrl.searchParams.get('sig') || '';
    let target;
    try { target = new URL(targetText); } catch (_) { return json(res, 400, { error: 'Invalid proxy target' }); }
    if (!['http:', 'https:'].includes(target.protocol)) {
      return json(res, 400, { error: 'Only HTTP(S) proxy targets are supported' });
    }
    if (target.username || target.password || !streamHostAllowed(target, config)) {
      return json(res, 403, { error: 'Proxy target host is not allowed' });
    }
    if (!signaturesEqual(signature, proxySignature(target.toString(), config.proxyToken))) {
      return json(res, 401, { error: 'Invalid proxy signature' });
    }

    try {
      await streamer(config.vlessUrl, target.toString(), {
        method: req.method,
        headers: incomingStreamHeaders(req),
        timeoutMs: Math.max(config.relayTimeoutMs, 30000),
        maxPlaylistBytes: config.maxPlaylistBytes,
        rewritePlaylist: (body, base) => rewritePlaylist(body, base, req, config),
        rewriteLocation: (location, base) => {
          try { return signedProxyUrl(new URL(location, base).toString(), req, config); } catch (_) { return location; }
        },
      }, res);
    } catch (_) {
      if (!res.headersSent && !res.writableEnded) return json(res, 502, { error: 'Upstream stream unavailable' });
      try { res.destroy(); } catch (_) {}
    }
  }

  return {
    config,
    manifest,
    registry,
    handler: handle,
    proxy: handleProxy,
    health: () => ({
      ok: true,
      addon: 'Iraq Scrapers',
      protocol: ['manifest', 'catalog', 'meta', 'stream'],
      config: publicConfig(config),
      vless: (() => {
        try { return config.vlessUrl ? maskedVlessConfig(parseVlessUrl(config.vlessUrl)) : { configured: false }; }
        catch (error) { return { configured: false, error: String(error.message || error) }; }
      })(),
      providers: registry.health(),
    }),
  };
}

if (require.main === module) {
  const app = createApp();
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url?.startsWith('/health'))) {
      return json(res, 200, app.health());
    }
    if (req.url?.startsWith('/proxy')) {
      let requestUrl;
      try { requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
      catch (_) { return json(res, 400, { error: 'Invalid request URL' }); }
      return app.proxy(req, res, requestUrl);
    }
    return app.handler(req, res);
  });
  server.listen(app.config.port, '0.0.0.0', () => {
    console.log(`Iraq Stremio addon listening on 0.0.0.0:${app.config.port}`);
  });
}

module.exports = { createApp, manifest, routeParts };
