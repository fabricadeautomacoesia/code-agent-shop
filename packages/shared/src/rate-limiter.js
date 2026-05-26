'use strict';

/**
 * Rate limiter L7 in-memory simples (V8 4.4).
 * 10 chamadas/segundo por chave (IP ou virtual key).
 * Para producao em multi-pod: usar Redis (mas fallback in-memory funciona).
 */
function createLimiter({ windowMs = 1000, max = 10, keyFn } = {}) {
  const counters = new Map(); // key -> [timestamps]
  return (req, res, next) => {
    const key = keyFn ? keyFn(req) : (req.headers['x-api-key'] || req.ip);
    const now = Date.now();
    const arr = counters.get(key) || [];
    const fresh = arr.filter((t) => now - t < windowMs);
    if (fresh.length >= max) {
      return res.status(429).json({ error: 'rate_limit_exceeded', retry_after_ms: windowMs - (now - fresh[0]) });
    }
    fresh.push(now);
    counters.set(key, fresh);
    next();
  };
}

setInterval(() => { /* cleanup global */ }, 60_000).unref();

module.exports = { createLimiter };
