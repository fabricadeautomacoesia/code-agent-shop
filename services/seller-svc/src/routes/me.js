'use strict';

const express = require('express');
const { z } = require('zod');
const { query, tx } = require('@cas/db-client');
const { jwt, asyncHandler, validate, errorHandler, crypto } = require('@cas/shared');

const router = express.Router();
router.use(jwt.requireAuth({ roles: ['seller','admin'] }));

// GET /sellers/me - perfil completo do seller logado
router.get('/', asyncHandler(async (req, res, next) => {
  const r = await query(
    `SELECT s.*, vp.qna_pending, vp.disputes_open, vp.products_in_qa,
            vp.products_rejected, vp.sla_days_remaining
       FROM sellers s
       LEFT JOIN vw_seller_pending vp ON vp.seller_id = s.id
      WHERE s.user_id = $1 AND s.deleted_at IS NULL`,
    [req.user.sub]
  );
  if (!r.rows.length) return next(errorHandler.notFound('seller_profile_not_found'));
  // ocultar fingerprint do documento
  const s = r.rows[0];
  delete s.document_number_hash;
  res.json({ seller: s });
}));

const updateSchema = z.object({
  store_name: z.string().min(3).max(120).optional(),
  store_description: z.string().max(5000).optional(),
  store_banner_url: z.string().url().optional(),
  store_logo_url: z.string().url().optional(),
  asaas_pix_key: z.string().max(200).optional(),
  allow_platform_resale: z.boolean().optional(),
});

router.patch('/', validate({ body: updateSchema }), asyncHandler(async (req, res) => {
  const cols = []; const vals = []; let i = 1;
  for (const [k,v] of Object.entries(req.body)) {
    cols.push(`${k} = $${i++}`); vals.push(v);
  }
  if (!cols.length) return res.json({ ok: true, noop: true });
  vals.push(req.user.sub);
  await query(`UPDATE sellers SET ${cols.join(', ')}, updated_at = NOW() WHERE user_id = $${i}`, vals);
  res.json({ ok: true });
}));

const kycSchema = z.object({
  document_type: z.enum(['cpf','cnpj']),
  document_number: z.string().min(11).max(20),
  legal_name: z.string().min(3).max(200),
  address_line1: z.string().min(3).max(200),
  address_city: z.string().min(2).max(100),
  address_state: z.string().length(2),
  address_zip: z.string().min(5).max(20),
});

// POST /sellers/me/kyc - submit KYC
router.post('/kyc', validate({ body: kycSchema }), asyncHandler(async (req, res) => {
  const b = req.body;
  const fp = crypto.sha256(b.document_number);
  await query(
    `UPDATE sellers SET
       document_type = $1, document_number_hash = $2, legal_name = $3,
       address_line1 = $4, address_city = $5, address_state = $6, address_zip = $7,
       status = 'active',
       updated_at = NOW()
     WHERE user_id = $8`,
    [b.document_type, fp, b.legal_name, b.address_line1, b.address_city, b.address_state, b.address_zip, req.user.sub]
  );
  res.json({ ok: true, status: 'active' });
}));

// GET /sellers/me/sla-status - timer da Classe B
router.get('/sla-status', asyncHandler(async (req, res) => {
  const r = await query(
    `SELECT id, seller_class, sla_active, sla_days, sla_last_upload_at, sla_next_deadline_at,
            sla_revoked_count, status,
            GREATEST(0, EXTRACT(DAY FROM (sla_next_deadline_at - NOW())))::INT AS days_remaining,
            EXTRACT(EPOCH FROM (sla_next_deadline_at - NOW()))::BIGINT AS seconds_remaining
       FROM sellers WHERE user_id = $1`, [req.user.sub]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'not_found' });
  res.json({ sla: r.rows[0] });
}));

// GET /sellers/me/sla-history
router.get('/sla-history', asyncHandler(async (req, res) => {
  const r = await query(
    `SELECT h.* FROM seller_sla_history h
       JOIN sellers s ON s.id = h.seller_id
      WHERE s.user_id = $1 ORDER BY h.created_at DESC LIMIT 50`, [req.user.sub]
  );
  res.json({ history: r.rows });
}));

// POST /sellers/me/payout - solicitar saque
router.post('/payout',
  validate({ body: z.object({ amount_cents: z.number().int().positive() }) }),
  asyncHandler(async (req, res, next) => {
    const s = await query('SELECT id, payout_min_amount_cents FROM sellers WHERE user_id = $1', [req.user.sub]);
    if (!s.rows.length) return next(errorHandler.notFound('seller_not_found'));
    const min = s.rows[0].payout_min_amount_cents || 5000;
    if (req.body.amount_cents < min) return next(errorHandler.badRequest('amount_below_min', `Minimo R$ ${(min/100).toFixed(2)}`));
    const r = await query(
      `INSERT INTO seller_payouts (seller_id, amount_cents) VALUES ($1,$2) RETURNING *`,
      [s.rows[0].id, req.body.amount_cents]
    );
    res.status(201).json({ payout: r.rows[0] });
  })
);

// FIX-WORKER-5: GET /sellers/me/payouts - historico de payouts do seller logado.
// Antes: dashboard-seller /financeiro tinha botao "Solicitar saque" mas zero
// visibilidade do que aconteceu depois (admin aprovou? rejeitou? processou?).
// Seller ficava no escuro apos solicitar - tinha que perguntar suporte.
router.get('/payouts', asyncHandler(async (req, res, next) => {
  const lim = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const s = await query('SELECT id FROM sellers WHERE user_id = $1', [req.user.sub]);
  if (!s.rows.length) return next(errorHandler.notFound('seller_not_found'));
  const r = await query(
    `SELECT id, amount_cents, status, asaas_transfer_id, requested_at,
            approved_at, paid_at, rejected_reason
       FROM seller_payouts
      WHERE seller_id = $1
      ORDER BY requested_at DESC LIMIT $2`,
    [s.rows[0].id, lim]
  );
  res.json({ payouts: r.rows, count: r.rows.length });
}));

// GET /sellers/me/kpi
router.get('/kpi', asyncHandler(async (req, res) => {
  const r = await query(
    `SELECT k.* FROM mv_seller_kpi k
       JOIN sellers s ON s.id = k.seller_id
      WHERE s.user_id = $1`, [req.user.sub]
  );
  res.json({ kpi: r.rows[0] || null });
}));

module.exports = router;
