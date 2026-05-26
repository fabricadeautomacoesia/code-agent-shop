'use strict';

/**
 * Sanitizacao anti-XSS (V8 23.9).
 * Aplica em req.body, req.query, req.params como middleware global.
 */
function sanitizeString(s) {
  return s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function deep(value) {
  if (value == null) return value;
  if (typeof value === 'string') return sanitizeString(value);
  if (Array.isArray(value)) return value.map(deep);
  if (typeof value === 'object') {
    if (value instanceof Date || Buffer.isBuffer(value)) return value;
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = deep(v);
    return out;
  }
  return value;
}

function middleware() {
  return (req, _res, next) => {
    // Express 5: req.query e req.params sao getter-only, sanitizar in-place
    if (req.body) req.body = deep(req.body);
    if (req.query) {
      try {
        for (const k of Object.keys(req.query)) req.query[k] = deep(req.query[k]);
      } catch { /* ignora se imutavel */ }
    }
    if (req.params) {
      try {
        for (const k of Object.keys(req.params)) req.params[k] = deep(req.params[k]);
      } catch { /* ignora se imutavel */ }
    }
    next();
  };
}

module.exports = { deep, sanitizeString, middleware };
