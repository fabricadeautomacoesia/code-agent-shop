'use strict';

/**
 * Fail2Ban in-memory (V8 23.4).
 * 5 falhas em 15min => ban de 15min do IP.
 * Fonte primaria. Audit log persiste em fail2ban_log se quiser.
 */
const MAX_ATTEMPTS = parseInt(process.env.FAIL2BAN_MAX_ATTEMPTS || '5', 10);
const BAN_MS       = parseInt(process.env.FAIL2BAN_BAN_DURATION_MS || '900000', 10);
const WINDOW_MS    = 15 * 60 * 1000;

const ipFailures = new Map();  // ip -> { count, firstAt, bannedUntil }

function _getRecord(ip) {
  let r = ipFailures.get(ip);
  if (!r) {
    r = { count: 0, firstAt: Date.now(), bannedUntil: null };
    ipFailures.set(ip, r);
  }
  return r;
}

function isBanned(ip) {
  const r = ipFailures.get(ip);
  if (!r) return false;
  if (r.bannedUntil && r.bannedUntil > Date.now()) return true;
  if (r.bannedUntil && r.bannedUntil <= Date.now()) {
    ipFailures.delete(ip);
    return false;
  }
  return false;
}

function reportFailure(ip) {
  const r = _getRecord(ip);
  if (Date.now() - r.firstAt > WINDOW_MS) {
    r.count = 1;
    r.firstAt = Date.now();
    return { count: r.count, banned: false };
  }
  r.count++;
  if (r.count >= MAX_ATTEMPTS) {
    r.bannedUntil = Date.now() + BAN_MS;
    return { count: r.count, banned: true, bannedUntil: r.bannedUntil };
  }
  return { count: r.count, banned: false };
}

function reportSuccess(ip) {
  ipFailures.delete(ip);
}

function middleware() {
  return (req, res, next) => {
    // FIX-WORKER-6: prioriza x-forwarded-for/x-real-ip do gateway (defesa em profundidade
    // caso trust proxy esteja off em algum svc). req.ip eh fallback.
    const xff = req.headers['x-forwarded-for'];
    const realIp = req.headers['x-real-ip'];
    const ip = (xff && String(xff).split(',')[0].trim())
             || realIp
             || req.ip
             || req.socket.remoteAddress
             || 'unknown';
    if (isBanned(ip)) {
      return res.status(403).json({ error: 'ip_banned', message: 'Muitas tentativas. Tente novamente em 15min.' });
    }
    req.fail2ban = { ip, reportFailure: () => reportFailure(ip), reportSuccess: () => reportSuccess(ip) };
    next();
  };
}

// Cleanup periodico (memory leak prevention)
setInterval(() => {
  const now = Date.now();
  for (const [ip, r] of ipFailures.entries()) {
    if (r.bannedUntil && r.bannedUntil < now) ipFailures.delete(ip);
    else if (!r.bannedUntil && now - r.firstAt > WINDOW_MS) ipFailures.delete(ip);
  }
}, 60_000).unref();

module.exports = { isBanned, reportFailure, reportSuccess, middleware, _ipFailures: ipFailures };
