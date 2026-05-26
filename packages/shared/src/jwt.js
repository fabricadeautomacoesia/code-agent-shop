'use strict';

const jwt = require('jsonwebtoken');
const crypto = require('crypto');

/**
 * JWT duplo (V8 21.6): access 15min + refresh 7d HTTP-only.
 */
const ACCESS_SECRET  = process.env.JWT_ACCESS_SECRET  || 'dev-access-secret-CHANGE-ME';
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-CHANGE-ME';
const ACCESS_TTL     = parseInt(process.env.JWT_ACCESS_TTL  || '900', 10);
const REFRESH_TTL    = parseInt(process.env.JWT_REFRESH_TTL || '604800', 10);

function signAccess(payload, opts = {}) {
  const jti = crypto.randomUUID();
  const token = jwt.sign({ ...payload, jti }, ACCESS_SECRET, {
    expiresIn: opts.ttl ?? ACCESS_TTL,
    issuer: 'cas',
    audience: 'cas-api',
  });
  return { token, jti, expiresIn: opts.ttl ?? ACCESS_TTL };
}

function signRefresh(payload, opts = {}) {
  const jti = crypto.randomUUID();
  const token = jwt.sign({ ...payload, jti, typ: 'refresh' }, REFRESH_SECRET, {
    expiresIn: opts.ttl ?? REFRESH_TTL,
    issuer: 'cas',
    audience: 'cas-refresh',
  });
  return { token, jti, expiresIn: opts.ttl ?? REFRESH_TTL };
}

function verifyAccess(token) {
  return jwt.verify(token, ACCESS_SECRET, { issuer: 'cas', audience: 'cas-api' });
}

function verifyRefresh(token) {
  return jwt.verify(token, REFRESH_SECRET, { issuer: 'cas', audience: 'cas-refresh' });
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Middleware Express: valida Bearer token, anexa req.user
 */
function requireAuth(opts = {}) {
  const requiredRoles = opts.roles || null;
  return async (req, res, next) => {
    try {
      const auth = req.headers.authorization || '';
      const [scheme, token] = auth.split(' ');
      if (scheme !== 'Bearer' || !token) {
        return res.status(401).json({ error: 'missing_token' });
      }
      const payload = verifyAccess(token);
      req.user = payload;
      req.token = { jti: payload.jti, raw: token };
      if (requiredRoles && !requiredRoles.includes(payload.role)) {
        return res.status(403).json({ error: 'forbidden_role' });
      }
      next();
    } catch (err) {
      const code = err.name === 'TokenExpiredError' ? 'token_expired' : 'invalid_token';
      return res.status(401).json({ error: code });
    }
  };
}

module.exports = { signAccess, signRefresh, verifyAccess, verifyRefresh, hashToken, requireAuth };
