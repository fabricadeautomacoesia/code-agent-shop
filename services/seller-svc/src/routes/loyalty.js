'use strict';

const express = require('express');
const { query, tx } = require('@cas/db-client');
const { jwt, asyncHandler } = require('@cas/shared');

const router = express.Router();
router.use(jwt.requireAuth());

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

// POST /loyalty/earn - sistema interno (chamado pelo order-svc apos pagamento)
// 1 ponto por R$ 1 gasto
router.post('/earn', asyncHandler(async (req, res) => {
  const { points, reason, reference_type, reference_id } = req.body;
  if (!points || points < 1) return res.status(400).json({ error: 'invalid_points' });
  await tx(async (c) => {
    await c.query(
      `INSERT INTO user_loyalty (user_id, points_balance, points_lifetime)
       VALUES ($1, $2, $2)
       ON CONFLICT (user_id) DO UPDATE SET
         points_balance = user_loyalty.points_balance + $2,
         points_lifetime = user_loyalty.points_lifetime + $2,
         updated_at = NOW()`,
      [req.user.sub, points]
    );
    await c.query(
      `INSERT INTO loyalty_transactions (user_id, points_delta, reason, reference_type, reference_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.user.sub, points, reason || 'purchase', reference_type || null, reference_id || null]
    );
    const lt = await c.query(`SELECT points_lifetime FROM user_loyalty WHERE user_id = $1`, [req.user.sub]);
    const newTier = calcTier(lt.rows[0].points_lifetime);
    await c.query(`UPDATE user_loyalty SET tier = $1 WHERE user_id = $2`, [newTier, req.user.sub]);
  });
  res.json({ ok: true });
}));

module.exports = router;
