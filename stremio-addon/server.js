'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const { publicConfig, readConfig } = require('./lib/config');
const { parseMediaId } = require('./lib/ids');
const { createProviderFetch } = require('./lib/relay-fetch');
const { createProviderRegistry } = require('./lib/provider-loader');
const { TmdbClient } = require('./lib/tmdb');
const { parseVlessUrl, streamViaVless } = require('./lib/vless-client');

const DEFAULT_PROVIDER_DIR = path.resolve(__dirname, '..', 'providers');

function manifest() {
  return {
    id: 'com.qvsalam.iraq-scrapers.stremio',
    version: '0.2.1',
    name: 'Iraq Scrapers',
    description: 'Arabic movie and series streams from the configured provider relay.',
    resources: ['catalog', 'meta', 'stream', 'subtitles'],
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
  const parts = pathname.split('/').slice(1);
  if (parts.length < 1) return null;
  const resource = parts[0];
  if (parts.length === 1 && (resource === 'manifest.json' || resource === 'manifest')) return { resource: 'manifest' };
  if (!['catalog', 'meta', 'stream', 'subtitles'].includes(resource) || parts.length < 3 || parts.length > 4 || parts.some((part) => !part)) return null;
  parts[parts.length - 1] = parts[parts.length - 1].replace(/\.json$/i, '');
  let id;
  try {
    id = decodeURIComponent(parts[2]);
    // Validate escapes without decoding query separators inside a value.
    if (parts[3]) decodeURIComponent(parts[3]);
  } catch (_) { return null; }
  const route = {
    resource,
    type: parts[1] === 'tv' ? 'series' : parts[1],
    id,
  };
  if (parts.length === 4) route.extra = Object.fromEntries(new URLSearchParams(parts[3]));
  return route;
}

function requestOrigin(req, config) {
  if (config.publicBaseUrl) return config.publicBaseUrl.replace(/\/$/, '');
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = ['http', 'https'].includes(forwarded) ? forwarded : (req.socket && req.socket.encrypted ? 'https' : 'http');
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
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
    if (config.streamHosts.size && ![...config.streamHosts].some((allowed) => allowed === hostname || (allowed.startsWith('.') && (hostname === allowed.slice(1) || hostname.endsWith(allowed))))) return false;
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
  if (!streamHostAllowed(url, config)) return `${requestOrigin(req, config)}/unavailable`;
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

function subtitleLanguage(value) {
  const language = String(value || 'und').trim().toLowerCase();
  const aliases = { ar: 'ara', arabic: 'ara', 'العربية': 'ara', en: 'eng', english: 'eng', ku: 'kur', kurdish: 'kur', tr: 'tur', turkish: 'tur', fa: 'per', persian: 'per' };
  return aliases[language] || language;
}

function streamSubtitles(stream, req, config) {
  const entries = Array.isArray(stream.subtitles) ? [...stream.subtitles] : [];
  if (Array.isArray(stream.tracks)) entries.push(...stream.tracks.filter((track) => !track.kind || track.kind === 'subtitles'));
  for (const url of [stream.subtitle, stream.subUrl]) if (url && !entries.some((entry) => (entry.url || entry.file) === url)) entries.push({ url });
  const seen = new Set();
  return entries.flatMap((entry) => {
    const raw = typeof entry === 'string' ? entry : entry?.url || entry?.file;
    if (!raw || !streamHostAllowed(raw, config)) return [];
    const target = new URL(raw).toString();
    const lang = subtitleLanguage(entry.lang || entry.language || entry.srclang);
    const key = `${target}\n${lang}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ id: crypto.createHash('sha256').update(key).digest('hex').slice(0, 24), url: signedProxyUrl(target, req, config), lang }];
  });
}

function homePage(req, res, config) {
  const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const manifestUrl = `${requestOrigin(req, config)}/manifest.json`;
  const installUrl = manifestUrl.replace(/^https?:\/\//, 'stremio://');
  const body = Buffer.from(`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Iraq Scrapers — Stremio</title><style>body{font:18px system-ui;background:#101524;color:#edf1fa;max-width:680px;margin:12vh auto;padding:24px;line-height:1.8}a{color:#a3c5ff}button,.install{display:inline-block;background:#6959dc;color:white;border:0;border-radius:10px;padding:12px 20px;font:inherit;text-decoration:none;cursor:pointer}input{box-sizing:border-box;width:100%;padding:12px;margin:16px 0;font:14px monospace;border-radius:8px;border:1px solid #59647d;background:#1b2336;color:white}</style><h1>Iraq Scrapers</h1><p>إضافة أفلام ومسلسلات إلى Stremio عبر المزوّدات العراقية المتاحة.</p><p><a class="install" href="${escape(installUrl)}">ثبّت الإضافة في Stremio</a></p><label for="manifest">رابط الإضافة</label><input id="manifest" dir="ltr" readonly value="${escape(manifestUrl)}"><button id="copy">نسخ الرابط</button><p id="status" role="status"></p><p>تقدر تلصق الرابط في قسم الإضافات داخل Stremio. قد يتأخر الطلب الأول عندما تكون خدمة Render المجانية نائمة.</p><script>document.getElementById('copy').addEventListener('click',async()=>{const field=document.getElementById('manifest');try{await navigator.clipboard.writeText(field.value);document.getElementById('status').textContent='تم نسخ الرابط'}catch{field.focus();field.select();document.getElementById('status').textContent='حدد الرابط وانسخه يدوياً'}})</script></html>`);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
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

    let requestUrl;
    try { requestUrl = new URL(req.url || '/', 'http://localhost'); }
    catch (_) { return json(res, 400, { error: 'Invalid request URL' }); }
    const route = routeParts(requestUrl.pathname);
    if (!route) return json(res, 404, { error: 'Not found' });

    try {
      if (route.resource === 'manifest') return json(res, 200, manifest());
      if (!['movie', 'series'].includes(route.type)) return json(res, 400, { error: 'Unsupported type' });

      if (route.resource === 'catalog') {
        const expectedId = route.type === 'movie' ? 'iraq-movies' : 'iraq-series';
        if (route.id !== expectedId) return json(res, 200, { metas: [] });
        const extra = { ...Object.fromEntries(requestUrl.searchParams), ...route.extra };
        const search = extra.search || '';
        const skip = Number(extra.skip || 0);
        if (!Number.isSafeInteger(skip) || skip < 0) return json(res, 200, { metas: [] });
        const page = Math.floor(Math.max(skip, 0) / 20) + 1;
        const metas = (await tmdb.catalog(route.type, search, page)) || [];
        return json(res, 200, { metas });
      }

      if (route.resource === 'meta') {
        const meta = await tmdb.meta(route.type, route.id);
        return json(res, 200, { meta: meta || { id: route.id, type: route.type, name: route.id, videos: [] } });
      }

      const responseKey = route.resource === 'subtitles' ? 'subtitles' : 'streams';
      const extra = { ...Object.fromEntries(requestUrl.searchParams), ...route.extra };
      const parsed = parseMediaId(route.resource === 'subtitles' && extra.videoID ? extra.videoID : route.id, route.type);
      if (!parsed || (route.type === 'series' && (parsed.season === undefined || parsed.episode === undefined))) return json(res, 200, { [responseKey]: [] });
      const resolvedId = parsed.tmdbId || await tmdb.resolveId(route.type, parsed.imdbId);
      if (!resolvedId) return json(res, 200, { [responseKey]: [] });
      // Do not leak direct provider URLs when stream proxying is enabled but
      // its credentials/configuration are missing.
      if (config.proxyStreams && (!config.vlessUrl || !config.proxyToken)) {
        return json(res, 200, { [responseKey]: [] });
      }
      const streams = await registry.getStreams(resolvedId, route.type, parsed.season, parsed.episode);
      if (route.resource === 'subtitles') {
        const subtitles = streams.flatMap((stream) => streamSubtitles(stream, req, config));
        return json(res, 200, { subtitles: [...new Map(subtitles.map((subtitle) => [subtitle.id, subtitle])).values()] });
      }
      return json(res, 200, {
        streams: streams.map((stream) => {
          if (config.proxyStreams && !streamHostAllowed(stream.url, config)) return null;
          const { tracks, subtitle, subUrl, subtitles: _subtitles, ...publicStream } = stream;
          return {
            ...publicStream,
            url: signedProxyUrl(stream.url, req, config),
            subtitles: streamSubtitles(stream, req, config),
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
      if (route.resource === 'subtitles') return json(res, 200, { subtitles: [] });
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
          targetAddress: config.targetAddresses?.[target.hostname],
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
    home: (req, res) => homePage(req, res, config),
    health: () => ({
      ok: true,
      addon: 'Iraq Scrapers',
      protocol: ['manifest', 'catalog', 'meta', 'stream', 'subtitles'],
      config: publicConfig(config),
      vless: (() => {
        try {
          if (!config.vlessUrl) return { configured: false };
          parseVlessUrl(config.vlessUrl);
          return { configured: true, valid: true };
        } catch (_) { return { configured: true, valid: false }; }
      })(),
      providers: registry.health(),
    }),
  };
}

if (require.main === module) {
  const app = createApp();
  const server = http.createServer((req, res) => {
    let requestUrl;
    try { requestUrl = new URL(req.url || '/', 'http://localhost'); }
    catch (_) { return json(res, 400, { error: 'Invalid request URL' }); }
    if (req.method === 'GET' && requestUrl.pathname === '/') return app.home(req, res);
    if (req.method === 'GET' && requestUrl.pathname === '/health') return json(res, 200, app.health());
    if (requestUrl.pathname === '/proxy') {
      return app.proxy(req, res, requestUrl);
    }
    return app.handler(req, res);
  });
  server.listen(app.config.port, '0.0.0.0', () => {
    console.log(`Iraq Stremio addon listening on 0.0.0.0:${app.config.port}`);
  });
}

module.exports = { createApp, manifest, routeParts };
