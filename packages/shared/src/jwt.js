'use strict';

const jwt = require('jsonwebtoken');
const crypto = require('crypto');

/**
 * JWT duplo (V8 21.6): access 15min + refresh 7d HTTP-only.
 *
 * FIX-WORKER-17 pass 6: fail-closed em producao.
 * Antes: fallback 'dev-access-secret-CHANGE-ME' permanente -> se ops subir
 * container sem env, sistema aceitava JWTs forjados com secret conhecido.
 * Comprometimento total (atacante forja qualquer role/sub).
 *
 * Agora: NODE_ENV=production EXIGE secrets com min 32 chars (256-bit entropy
 * minima para HS256). Falha rapida no module-load -> container nao sobe se
 * secrets ausentes/fracos -> Swarm reinicia com alerta nos logs ops.
 * Dev/test mantem fallback strings (sem essas, jest e local dev quebrariam).
 */
const PROD = process.env.NODE_ENV === 'production';
const MIN_SECRET_LEN = 32;

function _loadSecret(name) {
  const v = process.env[name];
  if (PROD) {
    if (!v || v.length < MIN_SECRET_LEN) {
      // Mensagem opaca (DLP): nao revela nome da env nem comprimento esperado nos logs externos
      // mas console.error eh permitido aqui pois e startup fatal (operador VAI ler).
      console.error(`[jwt] CRITICAL: ${name} ausente ou < ${MIN_SECRET_LEN} chars em producao - encerrando`);
      process.exit(1);
    }
    return v;
  }
  // Dev fallback (NAO usado em prod por causa do exit acima)
  return v || `dev-${name.toLowerCase().replace(/_/g, '-')}-CHANGE-ME`;
}

const ACCESS_SECRET  = _loadSecret('JWT_ACCESS_SECRET');
const REFRESH_SECRET = _loadSecret('JWT_REFRESH_SECRET');
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
