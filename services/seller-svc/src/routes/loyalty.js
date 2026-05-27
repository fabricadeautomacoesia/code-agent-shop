'use strict';

const express = require('express');
const crypto = require('node:crypto');
const { z } = require('zod');
const { query, tx } = require('@cas/db-client');
const { jwt, asyncHandler, validate, errorHandler, logger } = require('@cas/shared');

const log = logger.child({ svc: 'seller-svc', mod: 'loyalty' });
const router = express.Router();
router.use(jwt.requireAuth());

// FIX-WORKER-7 pass 45: service-token guard p/ endpoints internal-only.
// Pattern: header X-Service-Token timing-safe compare com env LOYALTY_SERVICE_SECRET.
// Order-svc (que faz internal call /earn pos-payment) configura header.
// User autenticado via JWT sem este header = 403.
// Fail-closed: secret ausente env = SEMPRE rejeita (anti misconfigured).
function serviceTokenGuard(req, res, next) {
  const secret = process.env.LOYALTY_SERVICE_SECRET;
  if (!secret) {
    log.error('[loyalty.service_misconfigured] LOYALTY_SERVICE_SECRET ausente env - rejeitando');
    return res.status(503).json({ error: 'service_not_configured' });
  }
  const provided = req.headers['x-service-token'] || '';
  let valid = false;
  try {
    const a = Buffer.from(provided);
    const b = Buffer.from(secret);
    valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { valid = false; }
  if (!valid) {
    log.warn({ ip: req.ip, user: req.user?.sub, ua: req.headers['user-agent'] },
      '[loyalty.service_token_invalid]');
    return res.status(403).json({ error: 'service_token_required' });
  }
  next();
}

// Tiers: starter (0-499) | gold (500-2999) | platinum (3000+)
function calcTier(lifetime) {
  if (lifetime >= 3000) return 'platinum';
  if (lifetime >= 500)  return 'gold';
  return 'starter';
}

// GET /loyalty/me - saldo + tier + historico
router.get('/me', asyncHandler(async (req, res) => {
  let bal = await query(
    `SELECT user_id, points_balance, points_lifetime, tier, updated_at
       FROM user_loyalty WHERE user_id = $1`, [req.user.sub]
  );
  if (!bal.rows.length) {
    await query(
      `INSERT INTO user_loyalty (user_id, points_balance, points_lifetime, tier)
       VALUES ($1, 0, 0, 'starter') ON CONFLICT DO NOTHING`, [req.user.sub]
    );
    bal = await query(`SELECT * FROM user_loyalty WHERE user_id = $1`, [req.user.sub]);
  }
  // MLB-NEW WORKER 16: limit configuravel via query (?limit=50 etc), default 20, max 200
  // FIX-WORKER-7 pass 4: Math.max(1, ...) clamp p/ rejeitar negativos
  const histLimit = Math.max(1, Math.min(parseInt(req.query.limit || '20', 10), 200));
  const hist = await query(
    `SELECT id, points_delta, reason, reference_type, reference_id, created_at
       FROM loyalty_transactions WHERE user_id = $1
       ORDER BY created_at DESC LIMIT $2`, [req.user.sub, histLimit]
  );
  // Bonus de boas-vindas se starter + sem nenhuma transacao
  if (bal.rows[0].tier === 'starter' && hist.rows.length === 0) {
    await tx(async (c) => {
      await c.query(
        `INSERT INTO loyalty_transactions (user_id, points_delta, reason)
         VALUES ($1, 100, 'welcome_bonus')`, [req.user.sub]
      );
      await c.query(
        `UPDATE user_loyalty SET points_balance = points_balance + 100,
                                  points_lifetime = points_lifetime + 100,
                                  updated_at = NOW()
          WHERE user_id = $1`, [req.user.sub]
      );
    });
    bal = await query(`SELECT * FROM user_loyalty WHERE user_id = $1`, [req.user.sub]);
    const newHist = await query(
      `SELECT * FROM loyalty_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [req.user.sub, histLimit]
    );
    return res.json({ loyalty: bal.rows[0], transactions: newHist.rows });
  }
  res.json({ loyalty: bal.rows[0], transactions: hist.rows });
}));

// POST /loyalty/earn - INTERNAL ENDPOINT (chamado pelo order-svc apos pagamento)
// 1 ponto por R$ 1 gasto.
//
// FIX-WORKER-7 pass 45: 5 BUGS CRITICOS aplicando Pattern W7.
//
// BUG 1 *** EXPOSED INTERNAL ENDPOINT *** free money exploit
//   PRE-FIX: router.use(jwt.requireAuth()) - QUALQUER user autenticado podia
//   POST /loyalty/earn {points:1000000, reason:'free'} -> 1M pontos balance
//   = exploit free money massivo (resgate ate 30% checkout)
//   FIX: serviceTokenGuard middleware - X-Service-Token timing-safe compare
//   order-svc deve configurar header em call interno
//   User direto sem token -> 403 service_token_required
//
// BUG 2 *** IDEMPOTENCY reference_id MISSING ***
//   User replay POST mesma reference_id 10x -> earn 10x pontos do mesmo order
//   FIX: SELECT existing tx (user_id+reason+reference_id) DENTRO tx
//   Se ja processado -> 200 OK noop com message
//   (NAO 409 - cliente legitimo order-svc retry deve receber ok)
//
// BUG 3 *** Validate Zod MISSING ***
//   if(!points||points<1) aceita points=1000000 sem max
//   reason arbitrary string XSS risk se renderizado em UI
//   FIX: Zod schema strict (points 1-100000 max, reason enum whitelist)
//
// BUG 4 *** AUDIT_LOG missing *** mutation balance financeiro sem trail
//   FIX: INSERT audit_log atomic dentro tx (LGPD + forense compliance)
//
// BUG 5 *** Tier promotion NOTIFICATION missing *** UX engagement
//   User passa starter->gold->platinum mas nunca sabe
//   FIX: detect previous tier vs new + notification se mudou
const earnSchema = z.object({
  user_id: z.string().uuid(),  // target user (vinda de order-svc, NAO req.user.sub)
  points: z.number().int().min(1).max(100000),  // cap anti-exploit
  reason: z.enum(['purchase','referral','promo','admin_adjust','review_bonus']),
  reference_type: z.enum(['order','referral','manual']).optional(),
  reference_id: z.string().max(100).optional(),
});

router.post('/earn',
  serviceTokenGuard,  // FIX bug 1: service-only
  validate({ body: earnSchema }),  // FIX bug 3: Zod strict
  asyncHandler(async (req, res, next) => {
    const { user_id, points, reason, reference_type, reference_id } = req.body;

    let outcome;
    let result;
    await tx(async (c) => {
      // FIX bug 2 (idempotency): check existing tx (user_id+reason+reference_id)
      // SO se reference_id presente (manual admin_adjust sem ref OK duplicar)
      if (reference_id) {
        const dup = await c.query(
          `SELECT id, created_at FROM loyalty_transactions
            WHERE user_id = $1::UUID AND reason = $2 AND reference_id = $3
            LIMIT 1`,
          [user_id, reason, reference_id]
        );
        if (dup.rows.length) {
          outcome = {
            duplicate: true,
            existing_tx_id: dup.rows[0].id,
            processed_at: dup.rows[0].created_at,
          };
          return;
        }
      }

      // FIX bug 1+2 (FOR UPDATE serializa): ler tier ANTES UPDATE p/ detectar promo
      const before = await c.query(
        `SELECT points_lifetime, tier FROM user_loyalty
          WHERE user_id = $1::UUID FOR UPDATE`,
        [user_id]
      );
      const prevTier = before.rows.length ? before.rows[0].tier : 'starter';

      // UPDATE/INSERT balance (upsert idempotent)
      await c.query(
        `INSERT INTO user_loyalty (user_id, points_balance, points_lifetime)
         VALUES ($1::UUID, $2::INT, $2::INT)
         ON CONFLICT (user_id) DO UPDATE SET
           points_balance = user_loyalty.points_balance + $2::INT,
           points_lifetime = user_loyalty.points_lifetime + $2::INT,
           updated_at = NOW()`,
        [user_id, points]
      );

      // INSERT transaction (idempotency guard - se reference_id duplicate retorna noop acima)
      await c.query(
        `INSERT INTO loyalty_transactions (user_id, points_delta, reason, reference_type, reference_id)
         VALUES ($1::UUID, $2::INT, $3, $4, $5)`,
        [user_id, points, reason, reference_type || null, reference_id || null]
      );

      // Calc novo tier + update se mudou
      const after = await c.query(
        `SELECT points_lifetime FROM user_loyalty WHERE user_id = $1::UUID`,
        [user_id]
      );
      const newLifetime = parseInt(after.rows[0].points_lifetime, 10);
      const newTier = calcTier(newLifetime);
      await c.query(
        `UPDATE user_loyalty SET tier = $1 WHERE user_id = $2::UUID`,
        [newTier, user_id]
      );

      // FIX bug 5: tier promotion notification (UX engagement)
      const tierRank = { starter: 0, gold: 1, platinum: 2 };
      if ((tierRank[newTier] || 0) > (tierRank[prevTier] || 0)) {
        await c.query(
          `INSERT INTO notifications (user_id, channel, template_code, title, body)
           VALUES ($1::UUID, 'in_app', 'loyalty_tier_up',
                   $2, $3)`,
          [user_id,
           `Voce subiu para o tier ${newTier.toUpperCase()}!`,
           `Voce agora tem ${newLifetime} pontos lifetime e beneficios exclusivos do tier ${newTier}.`]
        );
      }

      // FIX bug 4: audit_log atomic (financial mutation - LGPD compliance)
      await c.query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES (NULL, 'service', 'loyalty.earn', 'user_loyalty', $1::UUID, 'info', $2::JSONB)`,
        [user_id, JSON.stringify({
          points_delta: points,
          reason,
          reference_type: reference_type || null,
          reference_id: reference_id || null,
          new_lifetime: newLifetime,
          new_tier: newTier,
          tier_promoted: (tierRank[newTier] || 0) > (tierRank[prevTier] || 0),
          ip: req.ip,
        })]
      );

      result = { ok: true, new_balance: null /* sera lido fora tx */, new_tier: newTier };
    });

    if (outcome?.duplicate) {
      return res.json({
        ok: true,
        duplicate: true,
        message: 'Pontos ja foram creditados para esta referencia.',
        existing_tx_id: outcome.existing_tx_id,
        processed_at: outcome.processed_at,
      });
    }
    res.json(result);
  })
);

module.exports = router;
