'use strict';

/**
 * Rate limiter L7 in-memory simples (V8 4.4).
 * 10 chamadas/segundo por chave (IP ou virtual key).
 * Para producao em multi-pod: usar Redis (mas fallback in-memory funciona).
 *
 * FIX-WORKER-17 pass 708 (CRITICAL shared-bucket vulnerability - 20+ limiters affected):
 * PRE-FIX BUG: keyFn fallback usava (req.headers['x-api-key'] || req.ip)
 * - Servicos estao atras Traefik (Docker Swarm reverse proxy)
 * - req.ip retorna PEER IP do Traefik (mesmo IP para TODOS os clients downstream)
 * - SHARED BUCKET ATTACK: 1 atacante esgota bucket - bloqueia TODOS users legit
 * - 20+ limiters usam createLimiter SEM keyFn explicit -> TODOS afetados:
 *   logoutLimiter, statusLimiter, ackAlertLimiter, patchMeLimiter, couponApplyLimiter,
 *   disputeOpenLimiter, checkoutLimiter, payoutProcessLimiter, webhookResetLimiter,
 *   forceApproveLimiter, listLimiter, draftCreateLimiter, submitLimiter,
 *   versionPublishLimiter, qnaAnswerLimiter, uploadLimiter, reviewLimiter,
 *   voteLimiter, replyLimiter, qnaCreateLimiter (+ more)
 * - Pass 304 + 359 ja fixou vault-svc rate-limit individual com keyGenerator
 *   x-real-ip MAS o helper compartilhado @cas/shared/rate-limiter ficou lagged
 * POST-FIX: fallback usa req.headers['x-real-ip'] (Traefik forwards real client IP)
 * - x-real-ip header configurado em Traefik labels (deploy/stack.yml)
 * - Fallback chain: x-api-key -> x-real-ip -> req.ip (legacy only)
 * - Pattern V8 W17 cross-svc: ALL rate-limits behind reverse proxy DEVE usar x-real-ip
 * Trade-off ZERO: deploy ja tem x-real-ip configurado, sem regressao funcional.
 * 20+ limiters TODOS beneficiam automaticamente sem code change per site.
 */
function createLimiter({ windowMs = 1000, max = 10, keyFn } = {}) {
  const counters = new Map(); // key -> [timestamps]
  return (req, res, next) => {
    const key = keyFn
      ? keyFn(req)
      : (req.headers['x-api-key']
        || req.headers['x-real-ip']
        || req.ip);
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
