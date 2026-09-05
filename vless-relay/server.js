const http = require('node:http');
const tls = require('node:tls');
const { Duplex } = require('node:stream');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 10000);
const VLESS_URL = process.env.VLESS_URL || '';
const RELAY_TOKEN = process.env.RELAY_TOKEN || '';
const MAX_RESPONSE_BYTES = Math.max(64 * 1024, Number(process.env.MAX_RESPONSE_BYTES || 8 * 1024 * 1024));
const REQUEST_TIMEOUT_MS = Math.max(3000, Number(process.env.REQUEST_TIMEOUT_MS || 20000));

const DEFAULT_ALLOWED_HOSTS = [
  'movie.vodu.me',
  'isp.vodu.me',
  'api-cinema.shashety.com',
  'cinemana.shabakaty.com',
  'cinemana.shabakaty.cc',
  'cinema.albox.co',
];

const ALLOWED_HOSTS = new Set(
  String(process.env.ALLOWED_HOSTS || DEFAULT_ALLOWED_HOSTS.join(','))
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
);

const PROVIDER_TESTS = [
  { provider: 'VODU', url: 'https://movie.vodu.me/' },
  { provider: 'Shashety', url: 'https://api-cinema.shashety.com/' },
  {
    provider: 'Cinemana',
    url: 'https://cinemana.shabakaty.cc/api/android/AdvancedSearch?videoTitle=Inception&type=movies',
  },
  { provider: 'CinemaBox', url: 'https://cinema.albox.co/api/v4/public/movies' },
];

function json(res, status, data) {
  const body = Buffer.from(JSON.stringify(data, null, 2));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

function errorText(err) {
  return String(err && err.message ? err.message : err || 'Unknown error');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseVlessUrl(value) {
  if (!value) throw new Error('VLESS_URL is missing');
  const raw = String(value).trim();
  if (!raw.toLowerCase().startsWith('vless://')) throw new Error('VLESS_URL must start with vless://');

  const url = new URL(raw);
  const uuid = decodeURIComponent(url.username || '');
  const address = url.hostname;
  const port = Number(url.port || (url.searchParams.get('security') === 'tls' ? 443 : 80));
  const type = (url.searchParams.get('type') || 'tcp').toLowerCase();
  const security = (url.searchParams.get('security') || 'none').toLowerCase();
  const hostHeader = url.searchParams.get('host') || address;
  const servername = url.searchParams.get('sni') || hostHeader;
  const path = url.searchParams.get('path') || '/';

  if (!/^[0-9a-fA-F-]{36}$/.test(uuid)) throw new Error('Invalid VLESS UUID');
  if (!address) throw new Error('VLESS server address is missing');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid VLESS port');
  if (type !== 'ws') throw new Error(`Only VLESS type=ws is supported (got ${type})`);
  if (security !== 'tls') throw new Error(`Only VLESS security=tls is supported (got ${security})`);

  return {
    uuid,
    address,
    port,
    type,
    security,
    hostHeader,
    servername,
    path: path.startsWith('/') ? path : `/${path}`,
  };
}

function maskedConfig(cfg) {
  return {
    configured: true,
    address: cfg.address,
    port: cfg.port,
    type: cfg.type,
    security: cfg.security,
    host: cfg.hostHeader,
    sni: cfg.servername,
    path: cfg.path,
    uuid: `${cfg.uuid.slice(0, 8)}…${cfg.uuid.slice(-4)}`,
  };
}

function uuidToBytes(uuid) {
  const hex = String(uuid).replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error('Invalid VLESS UUID');
  const out = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function buildVlessHeader(uuid, targetHost, targetPort) {
  const id = uuidToBytes(uuid);
  const host = Buffer.from(targetHost, 'utf8');
  if (host.length > 255) throw new Error('Target hostname is too long');

  const out = Buffer.alloc(1 + 16 + 1 + 1 + 2 + 1 + 1 + host.length);
  let p = 0;
  out[p++] = 0x00;
  id.copy(out, p); p += 16;
  out[p++] = 0x00;
  out[p++] = 0x01;
  out[p++] = (targetPort >> 8) & 0xff;
  out[p++] = targetPort & 0xff;
  out[p++] = 0x02;
  out[p++] = host.length;
  host.copy(out, p);
  return out;
}

function openVlessWebSocket(cfg) {
  return new Promise((resolve, reject) => {
    const wsUrl = `wss://${cfg.address}:${cfg.port}${cfg.path}`;
    let settled = false;

    const ws = new WebSocket(wsUrl, {
      servername: cfg.servername,
      rejectUnauthorized: true,
      handshakeTimeout: REQUEST_TIMEOUT_MS,
      perMessageDeflate: false,
      headers: {
        Host: cfg.hostHeader,
        'User-Agent': 'iraq-vless-relay/1.0',
      },
    });

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    ws.once('open', () => finish(resolve, ws));
    ws.once('unexpected-response', (_req, response) => {
      finish(reject, new Error(`VLESS WebSocket rejected: HTTP ${response.statusCode || 0}`));
      try { ws.terminate(); } catch (_) {}
    });
    ws.once('error', (err) => finish(reject, new Error(`VLESS WebSocket error: ${errorText(err)}`)));
  });
}

function websocketDuplex(ws) {
  let responseHeaderDone = false;
  let pending = Buffer.alloc(0);
  let closed = false;

  const stream = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      if (closed || ws.readyState !== WebSocket.OPEN) {
        callback(new Error('VLESS WebSocket is closed'));
        return;
      }
      ws.send(Buffer.from(chunk), { binary: true }, callback);
    },
    final(callback) {
      callback();
    },
    destroy(err, callback) {
      closed = true;
      try { ws.terminate(); } catch (_) {}
      callback(err);
    },
  });

  ws.on('message', (data, isBinary) => {
    if (closed) return;
    try {
      let bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (!isBinary && !Buffer.isBuffer(data)) bytes = Buffer.from(String(data));

      if (!responseHeaderDone) {
        pending = Buffer.concat([pending, bytes]);
        if (pending.length < 2) return;
        const addonLength = pending[1];
        const offset = 2 + addonLength;
        if (pending.length < offset) return;
        bytes = pending.subarray(offset);
        pending = Buffer.alloc(0);
        responseHeaderDone = true;
      }

      if (bytes.length) stream.push(bytes);
    } catch (err) {
      stream.destroy(err);
    }
  });

  ws.once('close', () => {
    closed = true;
    try { stream.push(null); } catch (_) {}
  });
  ws.once('error', (err) => stream.destroy(err));

  return stream;
}

async function openVlessTunnel(targetHost, targetPort) {
  const cfg = parseVlessUrl(VLESS_URL);
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const ws = await openVlessWebSocket(cfg);
      const bridge = websocketDuplex(ws);
      ws.send(buildVlessHeader(cfg.uuid, targetHost, targetPort), { binary: true });
      return { cfg, ws, bridge };
    } catch (err) {
      lastError = err;
      if (attempt < 3) await sleep(300 * attempt);
    }
  }

  throw new Error(`Cannot open VLESS tunnel: ${errorText(lastError)}`);
}

function findHeaderEnd(buffer) {
  return buffer.indexOf(Buffer.from('\r\n\r\n'));
}

function parseHeaderBlock(buffer) {
  const end = findHeaderEnd(buffer);
  if (end < 0) return null;
  const text = buffer.subarray(0, end).toString('latin1');
  const lines = text.split('\r\n');
  const match = lines[0].match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/i);
  if (!match) throw new Error(`Invalid HTTP status line: ${lines[0] || '(empty)'}`);

  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const at = lines[i].indexOf(':');
    if (at <= 0) continue;
    const key = lines[i].slice(0, at).trim().toLowerCase();
    const value = lines[i].slice(at + 1).trim();
    headers[key] = headers[key] ? `${headers[key]}, ${value}` : value;
  }

  return {
    status: Number(match[1]),
    statusLine: lines[0],
    headers,
    bodyStart: end + 4,
  };
}

function dechunk(buffer) {
  const parts = [];
  let p = 0;
  while (p < buffer.length) {
    const eol = buffer.indexOf(Buffer.from('\r\n'), p);
    if (eol < 0) throw new Error('Incomplete chunked response');
    const sizeText = buffer.subarray(p, eol).toString('ascii').split(';', 1)[0].trim();
    const size = parseInt(sizeText, 16);
    if (!Number.isFinite(size)) throw new Error('Invalid chunk size');
    p = eol + 2;
    if (size === 0) return Buffer.concat(parts);
    if (p + size + 2 > buffer.length) throw new Error('Incomplete chunk body');
    parts.push(buffer.subarray(p, p + size));
    p += size;
    if (buffer[p] !== 13 || buffer[p + 1] !== 10) throw new Error('Invalid chunk terminator');
    p += 2;
  }
  throw new Error('Incomplete chunked response');
}

function responseComplete(buffer, parsed) {
  const bodyLength = buffer.length - parsed.bodyStart;
  const contentLength = Number(parsed.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength >= 0) return bodyLength >= contentLength;
  if ((parsed.headers['transfer-encoding'] || '').toLowerCase().includes('chunked')) {
    const body = buffer.subarray(parsed.bodyStart);
    return body.includes(Buffer.from('\r\n0\r\n\r\n')) || body.includes(Buffer.from('\r\n0\r\n'));
  }
  return false;
}

function collectHttpResponse(socket) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let parsed = null;
    let settled = false;

    const timer = setTimeout(() => finish(reject, new Error('Upstream response timeout')), REQUEST_TIMEOUT_MS);

    const cleanup = () => clearTimeout(timer);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };

    socket.on('data', (chunk) => {
      if (settled) return;
      const bytes = Buffer.from(chunk);
      chunks.push(bytes);
      total += bytes.length;
      if (total > MAX_RESPONSE_BYTES + 128 * 1024) {
        finish(reject, new Error(`Upstream response exceeds MAX_RESPONSE_BYTES (${MAX_RESPONSE_BYTES})`));
        return;
      }

      const all = Buffer.concat(chunks, total);
      if (!parsed) {
        try { parsed = parseHeaderBlock(all); } catch (err) { finish(reject, err); return; }
      }
      if (parsed && responseComplete(all, parsed)) finish(resolve, all);
    });

    socket.once('end', () => {
      const all = Buffer.concat(chunks, total);
      if (!all.length) finish(reject, new Error('Upstream closed without data'));
      else finish(resolve, all);
    });
    socket.once('close', () => {
      if (!settled) {
        const all = Buffer.concat(chunks, total);
        if (all.length) finish(resolve, all);
        else finish(reject, new Error('Upstream socket closed before data'));
      }
    });
    socket.once('error', (err) => finish(reject, err));
  });
}

function decodeHttpResponse(raw) {
  const parsed = parseHeaderBlock(raw);
  if (!parsed) throw new Error('Incomplete HTTP response headers');
  let body = raw.subarray(parsed.bodyStart);

  const contentLength = Number(parsed.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength >= 0 && body.length > contentLength) {
    body = body.subarray(0, contentLength);
  }
  if ((parsed.headers['transfer-encoding'] || '').toLowerCase().includes('chunked')) body = dechunk(body);

  return { ...parsed, body };
}

function buildRawRequest(target, method, headers, body) {
  const path = `${target.pathname || '/'}${target.search || ''}`;
  const lines = [
    `${method} ${path || '/'} HTTP/1.1`,
    `Host: ${target.host}`,
    `User-Agent: ${headers['user-agent'] || 'Mozilla/5.0 (Android) iraq-vless-relay/1.0'}`,
    `Accept: ${headers.accept || '*/*'}`,
    `Accept-Language: ${headers['accept-language'] || 'ar-IQ,ar;q=0.9,en;q=0.7'}`,
    'Accept-Encoding: identity',
    'Connection: close',
  ];

  const forward = ['authorization', 'cookie', 'content-type', 'range', 'if-none-match', 'if-modified-since', 'origin', 'referer', 'x-api-key'];
  for (const key of forward) {
    if (headers[key]) lines.push(`${key}: ${headers[key]}`);
  }
  if (body && body.length) lines.push(`Content-Length: ${body.length}`);

  return Buffer.concat([
    Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'utf8'),
    body || Buffer.alloc(0),
  ]);
}

async function requestViaVless(targetUrl, options = {}) {
  const target = new URL(targetUrl);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Only http:// and https:// targets are supported');

  const host = target.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host) && !options.allowAnyHost) {
    throw new Error(`Target host is not allowed: ${host}`);
  }

  const method = String(options.method || 'GET').toUpperCase();
  const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
  const { ws, bridge } = await openVlessTunnel(target.hostname, port);
  let socket = bridge;

  try {
    if (target.protocol === 'https:') {
      socket = tls.connect({
        socket: bridge,
        servername: target.hostname,
        rejectUnauthorized: true,
      });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('TLS handshake timeout')), REQUEST_TIMEOUT_MS);
        socket.once('secureConnect', () => { clearTimeout(timer); resolve(); });
        socket.once('error', (err) => { clearTimeout(timer); reject(err); });
      });
    }

    const request = buildRawRequest(target, method, options.headers || {}, options.body || Buffer.alloc(0));
    socket.write(request);
    const raw = await collectHttpResponse(socket);
    return decodeHttpResponse(raw);
  } finally {
    try { socket.destroy(); } catch (_) {}
    try { bridge.destroy(); } catch (_) {}
    try { ws.terminate(); } catch (_) {}
  }
}

function safeResponseHeaders(upstream) {
  const out = {
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  };
  const keep = ['content-type', 'location', 'etag', 'last-modified', 'accept-ranges', 'content-range'];
  for (const key of keep) if (upstream.headers[key]) out[key] = upstream.headers[key];
  out['content-length'] = upstream.body.length;
  return out;
}

function getIncomingHeaders(req) {
  const out = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) out[key.toLowerCase()] = value.join(', ');
    else if (value != null) out[key.toLowerCase()] = String(value);
  }
  return out;
}

function readRequestBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.once('end', () => resolve(Buffer.concat(chunks, total)));
    req.once('error', reject);
  });
}

function authorized(reqUrl, req) {
  if (!RELAY_TOKEN) return true;
  return req.headers['x-relay-token'] === RELAY_TOKEN || reqUrl.searchParams.get('token') === RELAY_TOKEN;
}

async function runProviderTests() {
  const results = [];
  for (const item of PROVIDER_TESTS) {
    const started = Date.now();
    try {
      const upstream = await requestViaVless(item.url, { method: 'GET', headers: {} });
      results.push({
        provider: item.provider,
        reachable: true,
        status: upstream.status,
        statusLine: upstream.statusLine,
        location: upstream.headers.location || null,
        contentType: upstream.headers['content-type'] || null,
        elapsedMs: Date.now() - started,
        body: upstream.body.toString('utf8', 0, Math.min(upstream.body.length, 1200)),
      });
    } catch (err) {
      results.push({
        provider: item.provider,
        reachable: false,
        status: 0,
        elapsedMs: Date.now() - started,
        error: errorText(err),
      });
    }
  }
  return results;
}

const server = http.createServer(async (req, res) => {
  const base = `http://${req.headers.host || 'localhost'}`;
  const url = new URL(req.url || '/', base);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,HEAD,POST,OPTIONS',
      'access-control-allow-headers': 'content-type,authorization,x-api-key,x-relay-token,range',
    });
    res.end();
    return;
  }

  if (url.pathname === '/' || url.pathname === '/health') {
    let vless;
    try { vless = maskedConfig(parseVlessUrl(VLESS_URL)); }
    catch (err) { vless = { configured: false, error: errorText(err) }; }

    json(res, 200, {
      ok: true,
      name: 'Iraq VLESS Relay',
      version: '1.0.0',
      vless,
      relayAuth: RELAY_TOKEN ? 'token-required' : 'disabled',
      allowedHosts: [...ALLOWED_HOSTS],
      endpoints: {
        egress: '/test/ip',
        providers: '/test/providers',
        relay: '/relay?url=https%3A%2F%2Fcinemana.shabakaty.cc%2F...',
      },
    });
    return;
  }

  if (!VLESS_URL) {
    json(res, 500, { ok: false, error: 'VLESS_URL is missing. Add it in Render Environment.' });
    return;
  }

  if (url.pathname === '/test/ip') {
    try {
      const upstream = await requestViaVless(
        'http://ip-api.com/json?fields=status,country,countryCode,regionName,city,isp,org,query',
        { method: 'GET', headers: {}, allowAnyHost: true }
      );
      let body = upstream.body.toString('utf8');
      try { body = JSON.parse(body); } catch (_) {}
      json(res, 200, {
        ok: upstream.status >= 200 && upstream.status < 400,
        tunnel: 'Render → VLESS → exit ISP',
        status: upstream.status,
        result: body,
      });
    } catch (err) {
      json(res, 502, { ok: false, tunnel: 'Render → VLESS → exit ISP', error: errorText(err) });
    }
    return;
  }

  if (url.pathname === '/test/providers') {
    const results = await runProviderTests();
    json(res, 200, {
      ok: results.some((x) => x.reachable),
      tunnel: 'Render → VLESS → exit ISP → provider',
      results,
    });
    return;
  }

  if (url.pathname === '/relay') {
    if (!authorized(url, req)) {
      json(res, 401, { ok: false, error: 'Invalid relay token' });
      return;
    }

    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) {
      json(res, 400, { ok: false, error: 'Missing ?url=' });
      return;
    }

    const method = String(req.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'POST'].includes(method)) {
      json(res, 405, { ok: false, error: 'Only GET, HEAD and POST are supported' });
      return;
    }

    try {
      const body = method === 'POST' ? await readRequestBody(req) : Buffer.alloc(0);
      const upstream = await requestViaVless(targetUrl, {
        method,
        headers: getIncomingHeaders(req),
        body,
      });
      res.writeHead(upstream.status, safeResponseHeaders(upstream));
      if (method === 'HEAD') res.end();
      else res.end(upstream.body);
    } catch (err) {
      json(res, 502, { ok: false, error: errorText(err) });
    }
    return;
  }

  json(res, 404, { ok: false, error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Iraq VLESS Relay listening on 0.0.0.0:${PORT}`);
});
