'use strict';

/**
 * MLB-12: Price Drop Alerts ("Avise-me se baixar")
 *
 * Equivalente Mercado Livre "Quero ser avisado". User loga, ativa alerta,
 * trigger BEFORE UPDATE no Postgres notifica via notifications outbox
 * quando price_cents cai. UI: botao "Avise-me se baixar" no PDP.
 */

const express = require('express');
const { z } = require('zod');
const { query } = require('@cas/db-client');
const { jwt, asyncHandler, validate, errorHandler } = require('@cas/shared');

const router = express.Router();
router.use(jwt.requireAuth());

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /products/price-alerts - lista alertas do user
router.get('/', asyncHandler(async (req, res) => {
  const r = await query(
    `SELECT a.id, a.product_id, a.threshold_cents, a.created_at, a.last_notified_at,
            p.slug, p.title, p.price_cents AS current_price_cents, p.cover_image_url
       FROM product_price_alerts a
       JOIN products p ON p.id = a.product_id
      WHERE a.user_id = $1
      ORDER BY a.created_at DESC LIMIT 100`,
    [req.user.sub]
  );
  res.json({ alerts: r.rows });
}));

// FIX-WORKER-3 pass 6: GET /products/price-alerts/check/:product_id
// Endpoint especifico para PDP frontend checar SE este produto esta no alert list.
// ANTES: frontend chamava GET / (lista todos 100 alertas) so para .some(filter).
// IMPACTO PRE-FIX: user com 50 alertas baixava ~5KB JSON por PDP open.
// AGORA: query indexada (user_id, product_id) -> linha unica, ~50 bytes.
// Pattern same wishlist /check (W7 endpoint estabelecido).
router.get('/check/:product_id', asyncHandler(async (req, res, next) => {
  if (!UUID_RE.test(req.params.product_id)) {
    return next(errorHandler.badRequest('invalid_uuid'));
  }
  const r = await query(
    `SELECT 1 FROM product_price_alerts
      WHERE user_id = $1 AND product_id = $2 LIMIT 1`,
    [req.user.sub, req.params.product_id]
  );
  res.json({ active: r.rows.length > 0 });
}));

// POST /products/price-alerts - cria alerta
router.post('/',
  validate({ body: z.object({
    product_id: z.string().uuid(),
    threshold_cents: z.number().int().positive().optional(),
  })}),
  asyncHandler(async (req, res, next) => {
    const r = await query(
      `INSERT INTO product_price_alerts (user_id, product_id, threshold_cents)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, product_id) DO UPDATE SET threshold_cents = EXCLUDED.threshold_cents
       RETURNING id, threshold_cents, created_at`,
      [req.user.sub, req.body.product_id, req.body.threshold_cents || null]
    );
    res.status(201).json({ alert: r.rows[0] });
  })
);

// DELETE /products/price-alerts/:product_id
router.delete('/:product_id', asyncHandler(async (req, res, next) => {
  if (!UUID_RE.test(req.params.product_id)) {
    return next(errorHandler.badRequest('invalid_uuid'));
  }
  const r = await query(
    `DELETE FROM product_price_alerts WHERE user_id = $1 AND product_id = $2 RETURNING id`,
    [req.user.sub, req.params.product_id]
  );
  if (!r.rows.length) return next(errorHandler.notFound('alert_not_found'));
  res.json({ ok: true });
}));

module.exports = router;
