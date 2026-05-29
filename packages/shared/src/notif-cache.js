'use strict';

/**
 * FIX-WORKER-13 pass 467: notif-cache helper cross-svc.
 *
 * CONTEXT:
 *   30+ INSERT INTO notifications cross-svc (auth-svc, payment-svc, order-svc,
 *   qa-svc, review-svc, product-svc, etc). Cada INSERT requires cache invalidation
 *   em notification-svc (2 caches: notifs:list:USER:* + notifs:unread-count:USER).
 *
 * PRE-PASS-467: cada cross-svc INSERT site fazia (ou esquecia):
 *     cache.del(`notifs:list:${userId}:*`).catch(() => {});
 *     cache.del(`notifs:unread-count:${userId}`).catch(() => {});
 *
 *   Inconsistencia:
 *   - Pass 459 implementou no notification-svc /prefs
 *   - notification-svc /:id/read pass 404
 *   - notification-svc /read-all pass 422
 *   - MAS cross-svc INSERT sites (30+): zero ou parcial
 *
 *   Resultado: user em outra tab com bell aberto NAO ve nova notif ate
 *   cache TTL 20s expirar. UX broken para anti-takeover alerts (2FA activate,
 *   refresh reuse, password reset) - mensagens CRITICAL stale.
 *
 * POST-FIX:
 *   Helper unico `invalidateUserNotifCache(userId)` em @cas/shared.
 *   - Cross-svc consistente (require + call)
 *   - Fire-and-forget (catch suprimido - Redis down nao quebra response)
 *   - Promise.all paralelo (latencia mininal)
 *
 *   Cross-svc INSERT sites podem agora:
 *     await c.query(`INSERT INTO notifications ...`);
 *     notifCache.invalidate(userId);
 *
 * SCOPE FUTURO (next passes consolidacao):
 *   Aplicar em todos 30+ sites cross-svc:
 *   - auth-svc 6 sites (2fa.activate, recovery, disable, refresh reuse, etc)
 *   - payment-svc 7 sites (PAYMENT_RECEIVED, payouts, etc)
 *   - order-svc 2 sites (dispute, free order)
 *   - qa-svc 1 site (callback notif seller)
 *   - review-svc 1 site (qna_new notif)
 *   - product-svc 1 site (version publish)
 *   - seller-svc loyalty.js 1 site (tier_up)
 */

const cache = require('./cache');

/**
 * Invalida ambos caches notification-svc para um user.
 * Fire-and-forget - Redis fail NAO bloqueia caller.
 *
 * @param {string} userId - UUID v4 do user (req.user.sub typically)
 * @returns {Promise<void>} sempre resolve (catch suppress)
 */
function invalidate(userId) {
  if (!userId) return Promise.resolve();
  return Promise.all([
    cache.del(`notifs:list:${userId}:*`),
    cache.del(`notifs:unread-count:${userId}`),
  ]).catch(() => {});
}

/**
 * Bulk invalidate p/ multiple users (uso em notification batches admin).
 * @param {Array<string>} userIds
 */
function invalidateBulk(userIds) {
  if (!Array.isArray(userIds) || !userIds.length) return Promise.resolve();
  return Promise.all(
    userIds.flatMap((uid) => [
      cache.del(`notifs:list:${uid}:*`),
      cache.del(`notifs:unread-count:${uid}`),
    ])
  ).catch(() => {});
}

module.exports = { invalidate, invalidateBulk };
