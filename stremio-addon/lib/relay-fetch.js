'use strict';

const { requestViaVless } = require('./vless-client');

function toUrl(input) {
  if (input instanceof URL) return input;
  if (typeof input === 'string') return new URL(input);
  if (input && typeof input.url === 'string') return new URL(input.url);
  throw new TypeError('A fully qualified URL is required');
}

function timeoutSignal(milliseconds) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(milliseconds);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), milliseconds).unref?.();
  return controller.signal;
}

function createProviderFetch({ config, baseFetch = globalThis.fetch }) {
  if (typeof baseFetch !== 'function') throw new Error('Global fetch is unavailable');

  function objectHeaders(headers) {
    const out = {};
    if (!headers) return out;
    if (headers instanceof Headers) {
      for (const [key, value] of headers.entries()) out[key] = value;
      return out;
    }
    for (const [key, value] of Object.entries(headers)) {
      if (value != null) out[key] = Array.isArray(value) ? value.join(', ') : String(value);
    }
    return out;
  }

  async function localVlessFetch(target, options = {}) {
    if (!config.vlessUrl) throw new Error('VLESS_URL is not configured');
    const method = String(options.method || 'GET').toUpperCase();
    let body = options.body || Buffer.alloc(0);
    if (typeof body === 'string') body = Buffer.from(body);
    if (!(body instanceof Uint8Array) && !Buffer.isBuffer(body)) body = Buffer.from(String(body));
    const upstream = await requestViaVless(config.vlessUrl, target.toString(), {
      method,
      headers: objectHeaders(options.headers),
      body: Buffer.from(body),
      timeoutMs: config.relayTimeoutMs,
      maxResponseBytes: config.maxResponseBytes,
    });
    const headers = new Headers();
    for (const [key, value] of Object.entries(upstream.headers || {})) headers.set(key, value);
    return new Response(method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers });
  }

  async function relayFetch(input, options = {}) {
    const target = toUrl(input);
    if (!config.relayUrl) {
      throw new Error('Provider relay is not configured (set RELAY_URL)');
    }

    const endpoint = new URL(config.relayUrl);
    endpoint.searchParams.set('url', target.toString());
    const headers = new Headers(options.headers || {});
    // The secret is sent only as a request header to the relay. It is never part
    // of a Stremio URL, a manifest, a log line, or a response body.
    if (config.relayToken) headers.set('x-relay-token', config.relayToken);
    headers.delete('host');
    headers.delete('content-length');

    const request = {
      ...options,
      method: String(options.method || 'GET').toUpperCase(),
      headers,
      signal: options.signal || timeoutSignal(config.relayTimeoutMs),
    };
    return baseFetch(endpoint, request);
  }

  async function providerFetch(input, options = {}) {
    const target = toUrl(input);
    if (!config.providerHosts.has(target.hostname.toLowerCase())) {
      return baseFetch(input, options);
    }
    if (config.allowDirectProviderFetch) return baseFetch(input, options);
    if (config.vlessUrl) return localVlessFetch(target, options);
    return relayFetch(target, options);
  }

  return { providerFetch, relayFetch, localVlessFetch };
}

module.exports = { createProviderFetch, toUrl };
