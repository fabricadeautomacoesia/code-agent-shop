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
// FIX-WORKER-7 pass 81: 6 BUGS aplicando Pattern W7 (Regras A+D+E+I + UX).
//
// BUG 1 *** Regra A MISSING *** alertas "fantasmas"
//   PRE-FIX: SEM filtro p.status / p.deleted_at - alertas para products
//   deletados/rejected continuam aparecendo. User confuso "produto sumiu mas
//   ainda recebo notif?".
//   FIX: status IN ('approved','platform_owned') + deleted_at IS NULL.
//   Pattern cross-svc estabelecido pass 73-80.
//
// BUG 2 *** Regra D *** ORDER BY a.created_at DESC sem tiebreaker
//   User criou bulk alerts (script) -> created_at identicos -> ordem indef.
//   FIX: + a.id DESC tiebreaker.
//
// BUG 3 *** Regra E *** hardcoded LIMIT 100 sem ?limit/?offset
//   Heavy user 200+ alerts -> só vê 100 primeiros.
//   FIX: ?limit (1-200, default 50) + ?offset + total + has_more.
//
// BUG 4 *** Regra I currency MISSING ***
//   PRE-FIX: response com price_cents mas sem currency - frontend assume BRL.
//   FIX: + p.currency (consistencia multi-currency futuro).
//
// BUG 5 *** UX total/has_more MISSING ***
//   Pagination UI sem visibility de fim.
//   FIX: COUNT + has_more.
//
// BUG 6 *** UX alert_status DERIVATIVE ***
//   Frontend sempre calcula "is_triggered = current_price <= threshold" client-side.
//   Centralize logica: server retorna is_triggered_now boolean.
//   Mantem compat (current_price_cents continua presente).
router.get('/', asyncHandler(async (req, res) => {
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

  const r = await query(
    `SELECT a.id, a.product_id, a.threshold_cents, a.created_at, a.last_notified_at,
            p.slug, p.title, p.price_cents AS current_price_cents,
            p.currency, p.cover_image_url,
            (a.threshold_cents IS NOT NULL
              AND p.price_cents <= a.threshold_cents) AS is_triggered_now
       FROM product_price_alerts a
       JOIN products p ON p.id = a.product_id
      WHERE a.user_id = $1
        AND p.status IN ('approved','platform_owned')
        AND p.deleted_at IS NULL
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $2 OFFSET $3`,
    [req.user.sub, limit, offset]
  );

  // Total count UX paginacao
  const totalRes = await query(
    `SELECT COUNT(*)::INT AS total FROM product_price_alerts a
       JOIN products p ON p.id = a.product_id
      WHERE a.user_id = $1
        AND p.status IN ('approved','platform_owned')
        AND p.deleted_at IS NULL`,
    [req.user.sub]
  );
  const total = totalRes.rows[0].total;

  res.json({
    alerts: r.rows,
    count: r.rows.length,
    total, limit, offset,
    has_more: (offset + r.rows.length) < total,
  });
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

// POST /products/price-alerts - cria/atualiza alerta
// FIX-WORKER-7 pass 81: 2 BUGS aplicando Pattern W7 (Regra A + threshold validation).
//
// BUG 1 *** Regra A MISSING *** pre-check produto vivo
//   PRE-FIX: INSERT direto sem verificar product. FK insere se product existe
//   no DB MAS pode ser deleted_at != NULL ou status='rejected'/'archived'.
//   Alerta criado para produto fantasma - nunca dispara mas ocupa storage.
//   FIX: pre-check status IN ('approved','platform_owned') + deleted_at IS NULL.
//
// BUG 2 *** threshold > current_price *** UX FAIL alerta sempre disparado
//   PRE-FIX: aceita {threshold_cents: 100000, current_price: 50000}.
//   Trigger DB cron dispara notification imediatamente (alerta ja "abaixou").
//   User confuso "criei agora e ja recebi notif".
//   FIX: validar threshold_cents <= current_price (se threshold informado).
//   Mensagem clara 400 thresholdMust be lower than current price.
router.post('/',
  validate({ body: z.object({
    product_id: z.string().uuid(),
    threshold_cents: z.number().int().positive().optional(),
  })}),
  asyncHandler(async (req, res, next) => {
    // BUG 1: pre-check produto vivo + retornar price_cents p/ BUG 2 validation
    const prod = await query(
      `SELECT id, price_cents FROM products
        WHERE id = $1
          AND status IN ('approved','platform_owned')
          AND deleted_at IS NULL
        LIMIT 1`,
      [req.body.product_id]
    );
    if (!prod.rows.length) return next(errorHandler.notFound('product_not_found'));

    // BUG 2: validar threshold <= current price (se informado)
    const currentPrice = prod.rows[0].price_cents;
    if (req.body.threshold_cents !== undefined && req.body.threshold_cents > currentPrice) {
      return res.status(400).json({
        error: 'threshold_above_current_price',
        message: 'Threshold deve ser menor ou igual ao preco atual.',
        current_price_cents: currentPrice,
        threshold_cents: req.body.threshold_cents,
      });
    }

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
