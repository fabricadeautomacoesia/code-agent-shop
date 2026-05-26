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
    if (req.body)   req.body   = deep(req.body);
    if (req.query)  req.query  = deep(req.query);
    if (req.params) req.params = deep(req.params);
    next();
  };
}

module.exports = { deep, sanitizeString, middleware };
