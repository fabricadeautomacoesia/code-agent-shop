'use strict';

/**
 * Redis cache helper (WORKER 18 PERF).
 *
 * - Singleton ioredis client com fallback no-op se REDIS_URL ausente
 *   ou conexao falhar. Nunca quebra o request por falha de cache (graceful).
 * - withCache(key, ttlSec, loaderFn): tenta GET, se MISS roda loader e SET.
 * - express middleware cacheMiddleware(keyFn, ttlSec): cache de response JSON.
 *   Header X-Cache: HIT|MISS adicionado para debug.
 */

const logger = require('./logger').default;

let client = null;
let disabled = false;

function getClient() {
  if (disabled) return null;
  if (client) return client;
  const url = process.env.REDIS_URL;
  if (!url) { disabled = true; return null; }
  try {
    const Redis = require('ioredis');
    client = new Redis(url, {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      connectTimeout: 3000,
    });
    client.on('error', (err) => {
      logger.warn({ err: err.message }, '[cache.redis_error]');
    });
    return client;
  } catch (e) {
    logger.warn({ err: e.message }, '[cache.init_fail]');
    disabled = true;
    return null;
  }
}

const PREFIX = process.env.REDIS_PREFIX || 'cas:';

async function get(key) {
  const c = getClient();
  if (!c) return null;
  try {
    const v = await c.get(PREFIX + key);
    return v ? JSON.parse(v) : null;
  } catch (e) {
    logger.warn({ err: e.message, key }, '[cache.get_fail]');
    return null;
  }
}

async function set(key, value, ttlSec = 60) {
  const c = getClient();
  if (!c) return false;
  try {
    await c.set(PREFIX + key, JSON.stringify(value), 'EX', ttlSec);
    return true;
  } catch (e) {
    logger.warn({ err: e.message, key }, '[cache.set_fail]');
    return false;
  }
}

async function del(pattern) {
  const c = getClient();
  if (!c) return 0;
  try {
    const keys = await c.keys(PREFIX + pattern);
    if (!keys.length) return 0;
    return c.del(...keys);
  } catch (e) {
    logger.warn({ err: e.message, pattern }, '[cache.del_fail]');
    return 0;
  }
}

async function withCache(key, ttlSec, loader) {
  const cached = await get(key);
  if (cached !== null) return { value: cached, hit: true };
  const value = await loader();
  await set(key, value, ttlSec);
  return { value, hit: false };
}

/**
 * Middleware Express. keyFn(req) -> string. Apenas GET.
 */
function cacheMiddleware(keyFn, ttlSec = 60) {
  return async (req, res, next) => {
    if (req.method !== 'GET') return next();
    let key;
    try { key = keyFn(req); } catch { return next(); }
    if (!key) return next();
    const cached = await get(key);
    if (cached !== null) {
      res.setHeader('X-Cache', 'HIT');
      return res.json(cached);
    }
    // Intercepta res.json para gravar no cache
    const origJson = res.json.bind(res);
    res.json = (body) => {
      res.setHeader('X-Cache', 'MISS');
      // Apenas cache de 2xx
      if (res.statusCode >= 200 && res.statusCode < 300) {
        set(key, body, ttlSec).catch(() => {});
      }
      return origJson(body);
    };
    next();
  };
}

module.exports = { get, set, del, withCache, cacheMiddleware };
