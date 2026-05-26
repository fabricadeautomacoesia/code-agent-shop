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
