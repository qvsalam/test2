'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PROVIDER_FILES = {
  vodu: 'vodu-titlefix.js',
  cinemabox: 'cinemabox-apk.js',
  cinemana: 'cinemana.js',
  shashety: 'shashety.js',
};

function loadProvider(filename, fetchImpl) {
  const source = fs.readFileSync(filename, 'utf8');
  const module = { exports: {} };
  const context = {
    module,
    exports: module.exports,
    fetch: fetchImpl,
    Buffer,
    URL,
    Promise,
    console: { error() {}, warn() {}, log() {} },
    setTimeout,
    clearTimeout,
    encodeURIComponent,
    decodeURIComponent,
  };
  vm.runInNewContext(source, context, { filename, displayErrors: true });
  if (!module.exports || typeof module.exports.getStreams !== 'function') {
    throw new Error(`Provider ${path.basename(filename)} does not export getStreams()`);
  }
  return module.exports;
}

function createProviderRegistry({ providerDir, fetchImpl, timeoutMs = 15000 }) {
  const loaded = [];
  const errors = {};
  for (const [id, basename] of Object.entries(PROVIDER_FILES)) {
    const filename = path.resolve(providerDir, basename);
    try {
      loaded.push({ id, filename, provider: loadProvider(filename, fetchImpl) });
    } catch (error) {
      errors[id] = String(error && error.message ? error.message : error);
    }
  }

  async function withTimeout(promise) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('provider timeout')), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function getStreams(tmdbId, type, season, episode) {
    const results = await Promise.all(
      loaded.map(async ({ id, provider }) => {
        try {
          const streams = await withTimeout(
            Promise.resolve(provider.getStreams(tmdbId, type === 'series' ? 'tv' : 'movie', season, episode)),
          );
          return Array.isArray(streams)
            ? streams.map((stream) => ({ ...stream, provider: stream.provider || id }))
            : [];
        } catch (_) {
          return [];
        }
      }),
    );

    const seen = new Set();
    return results.flat().filter((stream) => {
      if (!stream || typeof stream.url !== 'string' || !/^https?:\/\//i.test(stream.url)) return false;
      const key = stream.url;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function health() {
    return {
      loaded: loaded.map(({ id }) => id),
      errors,
    };
  }

  return { getStreams, health };
}

module.exports = { PROVIDER_FILES, createProviderRegistry, loadProvider };
