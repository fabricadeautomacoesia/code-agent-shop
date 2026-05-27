'use strict';

const express = require('express');
const { z } = require('zod');
const { query } = require('@cas/db-client');
const { jwt, asyncHandler, validate, errorHandler, logger } = require('@cas/shared');

const router = express.Router();
const log = logger.child({ svc: 'seller-svc', mod: 'admin' });
router.use(jwt.requireAuth({ roles: ['admin','staff'] }));

// POST /sellers/admin/:id/promote-class-b - admin promove seller a Classe B
router.post('/:id/promote-class-b',
  validate({ body: z.object({ sla_days: z.number().int().min(1).max(365).default(15) }) }),
  asyncHandler(async (req, res) => {
    const r = await query(
      `UPDATE sellers SET seller_class = 'class_b', sla_active = TRUE, sla_days = $1,
         sla_last_upload_at = NOW(),
         sla_next_deadline_at = NOW() + ($1 || ' days')::INTERVAL,
         updated_at = NOW()
       WHERE id = $2 RETURNING id, seller_class, sla_next_deadline_at`,
      [req.body.sla_days, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'not_found' });
    log.warn({ actor: req.user.sub, target: req.params.id }, '[seller.promote_b]');
    res.json({ seller: r.rows[0] });
  })
);

// POST /sellers/admin/:id/suspend (Kill Switch)
router.post('/:id/suspend',
  validate({ body: z.object({ reason: z.string().min(5).max(500) }) }),
  asyncHandler(async (req, res) => {
    await query(
      `UPDATE sellers SET status = 'suspended', updated_at = NOW()
       WHERE id = $1`, [req.params.id]
    );
    // revoga sessoes do usuario
    await query(
      `UPDATE user_sessions SET is_revoked = TRUE, revoked_reason = 'seller_suspended', revoked_at = NOW()
       WHERE user_id = (SELECT user_id FROM sellers WHERE id = $1)`,
      [req.params.id]
    );
    // audit
    await query(
      `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
       VALUES ($1,$2,'seller.suspend','seller',$3,'warn', $4::JSONB)`,
      [req.user.sub, req.user.role, req.params.id, JSON.stringify({ reason: req.body.reason })]
    );
    log.warn({ actor: req.user.sub, target: req.params.id, reason: req.body.reason }, '[seller.suspend]');
    res.json({ ok: true });
  })
);

// POST /sellers/admin/:id/reactivate
router.post('/:id/reactivate', asyncHandler(async (req, res) => {
  await query(
    `UPDATE sellers SET status = 'active', updated_at = NOW() WHERE id = $1`,
    [req.params.id]
  );
  res.json({ ok: true });
}));

// FIX-WORKER-4: GET /sellers/admin/sla-risk - sellers Classe B proximos do deadline SLA.
// Critical para admin agir antes da revogacao automatica de API keys.
// Threshold default: 3 dias (configuravel via query param ?days=N).
router.get('/sla-risk', asyncHandler(async (req, res) => {
  const days = Math.min(parseInt(req.query.days || '3', 10), 30);
  const r = await query(
    `SELECT s.id, s.store_name, s.store_slug, s.seller_class, s.sla_active,
            s.sla_days, s.sla_last_upload_at, s.sla_next_deadline_at,
            s.sla_revoked_count, s.status,
            EXTRACT(EPOCH FROM (s.sla_next_deadline_at - NOW()))/86400 AS days_remaining,
            u.email, u.full_name
       FROM sellers s
       JOIN users u ON u.id = s.user_id
      WHERE s.seller_class = 'class_b'
        AND s.sla_active = TRUE
        AND s.sla_next_deadline_at IS NOT NULL
        AND s.sla_next_deadline_at <= NOW() + ($1 || ' days')::INTERVAL
        AND s.status NOT IN ('suspended','banned')
      ORDER BY s.sla_next_deadline_at ASC LIMIT 100`,
    [String(days)]
  );
  res.json({ at_risk: r.rows, count: r.rows.length, threshold_days: days });
}));

// FIX-WORKER-4: GET /sellers/admin/all - listing geral com filtros + paginacao.
// Suporta ?status=active|pending_kyc|suspended|banned, ?seller_class=class_a|class_b,
// ?q=search_term (matches store_name ou email), ?limit, ?page.
router.get('/all', asyncHandler(async (req, res) => {
  const lim = Math.min(parseInt(req.query.limit || '30', 10), 100);
  const off = (Math.max(parseInt(req.query.page || '1', 10), 1) - 1) * lim;
  const where = ['1=1'];
  const params = [];
  let i = 1;
  if (req.query.status) {
    where.push(`s.status = $${i++}`); params.push(req.query.status);
  }
  if (req.query.seller_class) {
    where.push(`s.seller_class = $${i++}`); params.push(req.query.seller_class);
  }
  if (req.query.q) {
    where.push(`(s.store_name ILIKE $${i} OR u.email ILIKE $${i})`);
    params.push(`%${req.query.q}%`); i++;
  }
  params.push(lim, off);
  const r = await query(
    `SELECT s.id, s.store_slug, s.store_name, s.seller_class, s.status,
            s.reputation_tier, s.reputation_score, s.total_sales, s.total_products_active,
            s.created_at, u.email, u.full_name
       FROM sellers s JOIN users u ON u.id = s.user_id
      WHERE ${where.join(' AND ')}
      ORDER BY s.created_at DESC
      LIMIT $${i} OFFSET $${i+1}`,
    params
  );
  const cnt = await query(
    `SELECT COUNT(*) AS total FROM sellers s JOIN users u ON u.id = s.user_id WHERE ${where.join(' AND ')}`,
    params.slice(0, -2)
  );
  res.json({ sellers: r.rows, total: parseInt(cnt.rows[0].total, 10), page: parseInt(req.query.page || '1', 10), limit: lim });
}));

// GET /sellers/admin/pending-kyc
router.get('/pending-kyc', asyncHandler(async (req, res) => {
  const r = await query(
    `SELECT s.*, u.email, u.full_name FROM sellers s
       JOIN users u ON u.id = s.user_id
      WHERE s.status = 'pending_kyc'
      ORDER BY s.created_at ASC LIMIT 100`
  );
  res.json({ sellers: r.rows });
}));

// GET /sellers/admin/payouts/pending
router.get('/payouts/pending', asyncHandler(async (req, res) => {
  const r = await query(
    `SELECT p.*, s.store_name FROM seller_payouts p
       JOIN sellers s ON s.id = p.seller_id
      WHERE p.status = 'pending' ORDER BY p.requested_at ASC LIMIT 100`
  );
  res.json({ payouts: r.rows });
}));

// POST /sellers/admin/payouts/:id/approve
router.post('/payouts/:id/approve', asyncHandler(async (req, res) => {
  await query(
    `UPDATE seller_payouts SET status = 'approved', approved_at = NOW(), approved_by = $1
      WHERE id = $2 AND status = 'pending'`,
    [req.user.sub, req.params.id]
  );
  // payment-svc disparara Asaas transfer
  res.json({ ok: true });
}));

// POST /sellers/admin/payouts/:id/reject
router.post('/payouts/:id/reject',
  validate({ body: z.object({ reason: z.string().min(3) }) }),
  asyncHandler(async (req, res) => {
    await query(
      `UPDATE seller_payouts SET status = 'rejected', rejected_reason = $1
       WHERE id = $2 AND status = 'pending'`,
      [req.body.reason, req.params.id]
    );
    res.json({ ok: true });
  })
);

module.exports = router;
