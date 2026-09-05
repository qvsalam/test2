'use strict';

const tls = require('node:tls');
const { Duplex } = require('node:stream');

function errorText(error) {
  return String(error && error.message ? error.message : error || 'Unknown error');
}

function positiveInt(value, fallback, minimum = 1) {
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum ? number : fallback;
}

function parseVlessUrl(value) {
  if (!value) throw new Error('VLESS_URL is missing');
  const raw = String(value).trim();
  if (!raw.toLowerCase().startsWith('vless://')) throw new Error('VLESS_URL must start with vless://');

  const url = new URL(raw);
  const uuid = decodeURIComponent(url.username || '');
  const address = url.hostname;
  const port = Number(url.port || 443);
  const type = (url.searchParams.get('type') || 'tcp').toLowerCase();
  const security = (url.searchParams.get('security') || 'none').toLowerCase();
  const hostHeader = url.searchParams.get('host') || address;
  const servername = url.searchParams.get('sni') || hostHeader;
  const wsPath = url.searchParams.get('path') || '/';

  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(uuid)) throw new Error('Invalid VLESS UUID');
  if (!address) throw new Error('VLESS server address is missing');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid VLESS port');
  if (type !== 'ws') throw new Error(`Only VLESS type=ws is supported (got ${type})`);
  if (security !== 'tls') throw new Error(`Only VLESS security=tls is supported (got ${security})`);
  if ([hostHeader, servername, wsPath].some((part) => /[\r\n]/.test(String(part)))) {
    throw new Error('VLESS host, SNI, and path must not contain CR/LF');
  }

  return {
    uuid,
    address,
    port,
    type,
    security,
    hostHeader,
    servername,
    path: wsPath.startsWith('/') ? wsPath : `/${wsPath}`,
  };
}

function maskedVlessConfig(config) {
  return {
    configured: true,
    address: config.address,
    port: config.port,
    type: config.type,
    security: config.security,
    host: config.hostHeader,
    sni: config.servername,
    path: config.path,
    uuid: `${config.uuid.slice(0, 8)}…${config.uuid.slice(-4)}`,
  };
}

function uuidToBytes(uuid) {
  const hex = String(uuid).replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error('Invalid VLESS UUID');
  const out = Buffer.alloc(16);
  for (let index = 0; index < 16; index += 1) {
    out[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

function buildVlessHeader(uuid, targetHost, targetPort) {
  const id = uuidToBytes(uuid);
  const host = Buffer.from(targetHost, 'utf8');
  if (host.length > 255) throw new Error('Target hostname is too long');

  const out = Buffer.alloc(1 + 16 + 1 + 1 + 2 + 1 + 1 + host.length);
  let offset = 0;
  out[offset++] = 0x00; // VLESS version
  id.copy(out, offset); offset += 16;
  out[offset++] = 0x00; // addons length
  out[offset++] = 0x01; // TCP command
  out[offset++] = (targetPort >> 8) & 0xff;
  out[offset++] = targetPort & 0xff;
  out[offset++] = 0x02; // domain address type
  out[offset++] = host.length;
  host.copy(out, offset);
  return out;
}

function openVlessWebSocket(config, timeoutMs) {
  // Load ws only when VLESS is actually used. This keeps manifest/catalog
  // tests and local metadata-only runs usable before npm install.
  const WebSocket = require('ws');
  return new Promise((resolve, reject) => {
    const wsUrl = `wss://${config.address}:${config.port}${config.path}`;
    let settled = false;
    const ws = new WebSocket(wsUrl, {
      servername: config.servername,
      rejectUnauthorized: true,
      handshakeTimeout: timeoutMs,
      perMessageDeflate: false,
      headers: {
        Host: config.hostHeader,
        'User-Agent': 'iraq-stremio-addon/1.0',
      },
    });

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    ws.once('open', () => finish(resolve, ws));
    ws.once('unexpected-response', (_request, response) => {
      finish(reject, new Error(`VLESS WebSocket rejected: HTTP ${response.statusCode || 0}`));
      try { ws.terminate(); } catch (_) {}
    });
    ws.once('error', (error) => finish(reject, new Error(`VLESS WebSocket error: ${errorText(error)}`)));
  });
}

function websocketDuplex(ws) {
  const OPEN = ws.constructor.OPEN || 1;
  let responseHeaderDone = false;
  let pending = Buffer.alloc(0);
  let closed = false;

  const stream = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      if (closed || ws.readyState !== OPEN) {
        callback(new Error('VLESS WebSocket is closed'));
        return;
      }
      ws.send(Buffer.from(chunk), { binary: true }, callback);
    },
    final(callback) { callback(); },
    destroy(error, callback) {
      closed = true;
      try { ws.terminate(); } catch (_) {}
      callback(error);
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
        if (pending[0] !== 0x00) throw new Error('Invalid VLESS response version');
        const addonLength = pending[1];
        const offset = 2 + addonLength;
        if (pending.length < offset) return;
        bytes = pending.subarray(offset);
        pending = Buffer.alloc(0);
        responseHeaderDone = true;
      }
      if (bytes.length) stream.push(bytes);
    } catch (error) {
      stream.destroy(error);
    }
  });
  ws.once('close', () => {
    closed = true;
    try { stream.push(null); } catch (_) {}
  });
  ws.once('error', (error) => stream.destroy(error));
  return stream;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function openVlessTunnel(value, targetHost, targetPort, options = {}) {
  const config = options.config || parseVlessUrl(value);
  const timeoutMs = positiveInt(options.timeoutMs, 20000, 1000);
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const ws = await openVlessWebSocket(config, timeoutMs);
      const bridge = websocketDuplex(ws);
      ws.send(buildVlessHeader(config.uuid, targetHost, targetPort), { binary: true });
      return { config, ws, bridge };
    } catch (error) {
      lastError = error;
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
  for (let index = 1; index < lines.length; index += 1) {
    const at = lines[index].indexOf(':');
    if (at <= 0) continue;
    const key = lines[index].slice(0, at).trim().toLowerCase();
    const value = lines[index].slice(at + 1).trim();
    headers[key] = headers[key] ? `${headers[key]}, ${value}` : value;
  }
  return { status: Number(match[1]), statusLine: lines[0], headers, bodyStart: end + 4 };
}

function dechunk(buffer) {
  const parts = [];
  let offset = 0;
  while (offset < buffer.length) {
    const eol = buffer.indexOf(Buffer.from('\r\n'), offset);
    if (eol < 0) throw new Error('Incomplete chunked response');
    const sizeText = buffer.subarray(offset, eol).toString('ascii').split(';', 1)[0].trim();
    const size = parseInt(sizeText, 16);
    if (!Number.isFinite(size) || size < 0) throw new Error('Invalid chunk size');
    offset = eol + 2;
    if (size === 0) return Buffer.concat(parts);
    if (offset + size + 2 > buffer.length) throw new Error('Incomplete chunk body');
    parts.push(buffer.subarray(offset, offset + size));
    offset += size;
    if (buffer[offset] !== 13 || buffer[offset + 1] !== 10) throw new Error('Invalid chunk terminator');
    offset += 2;
  }
  throw new Error('Incomplete chunked response');
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

function buildRawRequest(target, method, headers = {}, body = Buffer.alloc(0)) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (value != null) normalized[String(key).toLowerCase()] = String(value);
  }
  const path = `${target.pathname || '/'}${target.search || ''}`;
  const lines = [
    `${method} ${path || '/'} HTTP/1.1`,
    `Host: ${target.host}`,
    `User-Agent: ${normalized['user-agent'] || 'Mozilla/5.0 (Android) iraq-stremio-addon/1.0'}`,
    `Accept: ${normalized.accept || '*/*'}`,
    `Accept-Language: ${normalized['accept-language'] || 'ar-IQ,ar;q=0.9,en;q=0.7'}`,
    'Accept-Encoding: identity',
    'Connection: close',
  ];
  const forward = [
    'authorization', 'cookie', 'content-type', 'range', 'if-none-match', 'if-modified-since',
    'if-range', 'origin', 'referer', 'x-api-key',
  ];
  for (const key of forward) if (normalized[key]) lines.push(`${key}: ${normalized[key]}`);
  if (body && body.length) lines.push(`Content-Length: ${body.length}`);
  return Buffer.concat([
    Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'utf8'),
    body || Buffer.alloc(0),
  ]);
}

async function connectTarget(value, targetUrl, options = {}) {
  const target = new URL(targetUrl);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Only http:// and https:// targets are supported');
  const targetPort = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
  const tunnel = await openVlessTunnel(value, target.hostname, targetPort, options);
  let socket = tunnel.bridge;
  try {
    if (target.protocol === 'https:') {
      socket = tls.connect({ socket: tunnel.bridge, servername: target.hostname, rejectUnauthorized: true });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('TLS handshake timeout')), options.timeoutMs || 20000);
        socket.once('secureConnect', () => { clearTimeout(timer); resolve(); });
        socket.once('error', (error) => { clearTimeout(timer); reject(error); });
      });
    }
    return { target, socket, bridge: tunnel.bridge, ws: tunnel.ws };
  } catch (error) {
    try { socket.destroy(); } catch (_) {}
    try { tunnel.bridge.destroy(); } catch (_) {}
    try { tunnel.ws.terminate(); } catch (_) {}
    throw error;
  }
}

async function requestViaVless(value, targetUrl, options = {}) {
  const timeoutMs = positiveInt(options.timeoutMs, 20000, 1000);
  const maxResponseBytes = positiveInt(options.maxResponseBytes, 64 * 1024 * 1024, 64 * 1024);
  const connection = await connectTarget(value, targetUrl, { ...options, timeoutMs });
  const { target, socket, bridge, ws } = connection;
  try {
    const method = String(options.method || 'GET').toUpperCase();
    socket.write(buildRawRequest(target, method, options.headers || {}, options.body || Buffer.alloc(0)));
    const chunks = [];
    let total = 0;
    let settled = false;
    let parsed;
    const raw = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(reject, new Error('Upstream response timeout')), timeoutMs);
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
        if (total > maxResponseBytes + 128 * 1024) {
          finish(reject, new Error(`Upstream response exceeds MAX_RESPONSE_BYTES (${maxResponseBytes})`));
          return;
        }
        const all = Buffer.concat(chunks, total);
        if (!parsed) {
          try { parsed = parseHeaderBlock(all); } catch (error) { finish(reject, error); return; }
        }
        if (parsed && Number.isFinite(Number(parsed.headers['content-length']))) {
          const length = Number(parsed.headers['content-length']);
          if (all.length >= parsed.bodyStart + length) finish(resolve, all);
        } else if (parsed && (parsed.headers['transfer-encoding'] || '').toLowerCase().includes('chunked')) {
          try { dechunk(all.subarray(parsed.bodyStart)); finish(resolve, all); } catch (_) {}
        }
      });
      socket.once('end', () => {
        const all = Buffer.concat(chunks, total);
        if (all.length) finish(resolve, all);
        else finish(reject, new Error('Upstream closed without data'));
      });
      socket.once('close', () => {
        if (settled) return;
        const all = Buffer.concat(chunks, total);
        if (all.length) finish(resolve, all);
        else finish(reject, new Error('Upstream socket closed before data'));
      });
      socket.once('error', (error) => finish(reject, error));
    });
    return decodeHttpResponse(raw);
  } finally {
    try { socket.destroy(); } catch (_) {}
    try { bridge.destroy(); } catch (_) {}
    try { ws.terminate(); } catch (_) {}
  }
}

function responseHeaders(headers, rewriteLocation) {
  const out = {
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'content-length, content-range, accept-ranges, etag, last-modified, location',
  };
  for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'cache-control', 'expires', 'location']) {
    if (!headers[key]) continue;
    out[key] = key === 'location' && typeof rewriteLocation === 'function'
      ? rewriteLocation(headers[key])
      : headers[key];
  }
  return out;
}

function parseChunkedBody(buffer, state, final = false) {
  // A zero-size chunk terminates the body. Trailers can arrive in a later
  // WebSocket frame; ignore them instead of parsing them as a new size line.
  if (state.done) return { body: Buffer.alloc(0), leftover: Buffer.alloc(0) };
  const output = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (state.remaining == null) {
      const eol = buffer.indexOf(Buffer.from('\r\n'), offset);
      if (eol < 0) break;
      const size = parseInt(buffer.subarray(offset, eol).toString('ascii').split(';', 1)[0].trim(), 16);
      if (!Number.isFinite(size) || size < 0) throw new Error('Invalid chunk size');
      state.remaining = size;
      offset = eol + 2;
      if (size === 0) {
        state.done = true;
        const trailerEnd = buffer.indexOf(Buffer.from('\r\n'), offset);
        if (trailerEnd >= 0) offset = trailerEnd + 2;
        break;
      }
    }
    const available = Math.min(state.remaining, buffer.length - offset);
    if (available > 0) {
      output.push(buffer.subarray(offset, offset + available));
      state.remaining -= available;
      offset += available;
    }
    if (state.remaining > 0) break;
    if (offset + 2 > buffer.length) break;
    if (buffer[offset] !== 13 || buffer[offset + 1] !== 10) throw new Error('Invalid chunk terminator');
    offset += 2;
    state.remaining = null;
  }
  if (final && !state.done) throw new Error('Incomplete chunked response');
  return { body: Buffer.concat(output), leftover: buffer.subarray(offset) };
}

async function streamViaVless(value, targetUrl, options = {}, response) {
  const timeoutMs = positiveInt(options.timeoutMs, 30000, 1000);
  const maxPlaylistBytes = positiveInt(options.maxPlaylistBytes, 4 * 1024 * 1024, 64 * 1024);
  const connection = await connectTarget(value, targetUrl, { ...options, timeoutMs });
  const { target, socket, bridge, ws } = connection;
  let headersSent = false;
  let settled = false;
  let headerBuffer = Buffer.alloc(0);
  let parsed;
  let bodyBuffer = Buffer.alloc(0);
  let bodyRemainder = Buffer.alloc(0);
  let contentRemaining = null;
  const chunkState = { remaining: null, done: false };
  const requestedPlaylist = /(?:\.m3u8|\.m3u)(?:$|\?)/i.test(target.pathname);
  let isPlaylist = requestedPlaylist;

  const finish = (error) => {
    if (settled) return;
    settled = true;
    try {
      if (error && !response.headersSent) response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      if (error && !response.writableEnded) response.end(JSON.stringify({ ok: false, error: errorText(error) }));
      else if (!response.writableEnded) response.end();
    } catch (_) {}
    try { socket.destroy(); } catch (_) {}
    try { bridge.destroy(); } catch (_) {}
    try { ws.terminate(); } catch (_) {}
  };

  const sendHeaders = () => {
    if (headersSent) return;
    headersSent = true;
    const headers = responseHeaders(parsed.headers, (location) => {
      if (typeof options.rewriteLocation !== 'function') return location;
      return options.rewriteLocation(location, target);
    });
    // Rewritten playlists change their byte length; normal media can keep
    // the upstream length so Stremio can seek and show progress correctly.
    const method = String(options.method || 'GET').toUpperCase();
    if (isPlaylist && method !== 'HEAD') delete headers['content-length'];
    if (parsed.headers['content-range']) headers['content-range'] = parsed.headers['content-range'];
    response.writeHead(parsed.status, headers);
  };

  const writeBody = (chunk) => {
    if (!chunk || !chunk.length) return;
    if (isPlaylist) {
      bodyBuffer = Buffer.concat([bodyBuffer, chunk]);
      if (bodyBuffer.length > maxPlaylistBytes) throw new Error('Playlist exceeds MAX_PLAYLIST_BYTES');
      return;
    }
    sendHeaders();
    response.write(chunk);
  };

  const processBody = (chunk, final = false) => {
    let data = Buffer.concat([bodyRemainder, chunk || Buffer.alloc(0)]);
    bodyRemainder = Buffer.alloc(0);
    if ((parsed.headers['transfer-encoding'] || '').toLowerCase().includes('chunked')) {
      const decoded = parseChunkedBody(data, chunkState, final);
      bodyRemainder = decoded.leftover;
      writeBody(decoded.body);
      return;
    }
    if (contentRemaining != null) {
      const take = Math.min(contentRemaining, data.length);
      writeBody(data.subarray(0, take));
      contentRemaining -= take;
      bodyRemainder = data.subarray(take);
      return;
    }
    writeBody(data);
  };

  socket.write(buildRawRequest(target, String(options.method || 'GET').toUpperCase(), options.headers || {}, options.body || Buffer.alloc(0)));
  let timer;
  let doneHandler;
  return new Promise((resolve, reject) => {
    const done = (error) => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (error) { finish(error); reject(error); return; }
      try {
        if (isPlaylist && !response.writableEnded) {
          sendHeaders();
          const playlist = typeof options.rewritePlaylist === 'function'
            ? options.rewritePlaylist(bodyBuffer.toString('utf8'), target)
            : bodyBuffer;
          response.end(playlist);
        } else if (!response.writableEnded) {
          if (!headersSent) sendHeaders();
          response.end();
        }
        settled = true;
        try { socket.destroy(); } catch (_) {}
        try { bridge.destroy(); } catch (_) {}
        try { ws.terminate(); } catch (_) {}
        resolve();
      } catch (error2) {
        finish(error2);
        reject(error2);
      }
    };

    doneHandler = done;
    timer = setTimeout(() => done(new Error('Upstream response timeout')), timeoutMs);

    socket.on('data', (chunk) => {
      if (settled) return;
      try {
        let data = Buffer.from(chunk);
        if (!parsed) {
          headerBuffer = Buffer.concat([headerBuffer, data]);
          parsed = parseHeaderBlock(headerBuffer);
          if (!parsed) return;
          if (timer) { clearTimeout(timer); timer = null; }
          data = headerBuffer.subarray(parsed.bodyStart);
          headerBuffer = Buffer.alloc(0);
          isPlaylist = requestedPlaylist || /mpegurl|vnd\.apple\.mpegurl/i.test(parsed.headers['content-type'] || '');
          const length = Number(parsed.headers['content-length']);
          contentRemaining = Number.isFinite(length) && length >= 0 ? length : null;
          if (String(options.method || 'GET').toUpperCase() === 'HEAD') {
            sendHeaders();
            return done();
          }
        }
        processBody(data);
        if (contentRemaining === 0 || chunkState.done) done();
      } catch (error) { done(error); }
    });
    socket.once('end', () => {
      if (settled) return;
      try { processBody(Buffer.alloc(0), true); done(); } catch (error) { done(error); }
    });
    socket.once('close', () => {
      if (!settled) {
        try { processBody(Buffer.alloc(0), true); done(); } catch (error) { done(error); }
      }
    });
    socket.once('error', (error) => { if (!settled) done(error); });
    response.once('close', () => {
      if (!settled && doneHandler) doneHandler(new Error('Client disconnected'));
    });
  });
}

module.exports = {
  buildRawRequest,
  buildVlessHeader,
  decodeHttpResponse,
  maskedVlessConfig,
  parseVlessUrl,
  requestViaVless,
  responseHeaders,
  streamViaVless,
  uuidToBytes,
};
