'use strict';

const express = require('express');
const crypto = require('node:crypto');
const { z } = require('zod');
const { query, tx } = require('@cas/db-client');
const { jwt, asyncHandler, validate, errorHandler, logger } = require('@cas/shared');

const router = express.Router();
const log = logger.child({ svc: 'order-svc', mod: 'orders' });
router.use(jwt.requireAuth());

const TAKE_RATE = parseFloat(process.env.PLATFORM_TAKE_RATE || '0.18');

// POST /orders/checkout - cria pedido a partir do cart
router.post('/checkout',
  validate({ body: z.object({ payment_method: z.enum(['pix','credit_card','boleto']) })}),
  asyncHandler(async (req, res, next) => {
    const result = await tx(async (c) => {
      const cart = await c.query(
        `SELECT * FROM carts WHERE user_id = $1 FOR UPDATE`, [req.user.sub]
      );
      if (!cart.rows.length || cart.rows[0].items_count === 0)
        throw errorHandler.badRequest('empty_cart');
      const items = await c.query(
        `SELECT ci.*, p.title, p.seller_id, p.is_platform_owned, p.platform_resale_enabled,
                s.custom_commission_rate, s.asaas_wallet_id
           FROM cart_items ci
           JOIN products p ON p.id = ci.product_id
           LEFT JOIN sellers s ON s.id = p.seller_id
          WHERE ci.cart_id = $1`, [cart.rows[0].id]
      );

      const orderNo = await c.query(`SELECT fn_generate_order_number() AS n`);
      const order = await c.query(
        `INSERT INTO orders (order_number, buyer_user_id, status, subtotal_cents, discount_cents,
                             coupon_code, total_cents, currency, payment_method, payment_status,
                             buyer_ip, buyer_user_agent, expires_at)
         VALUES ($1,$2,'pending_payment',$3,$4,$5,$6,$7,$8,'pending',$9,$10, NOW() + INTERVAL '24 hours')
         RETURNING *`,
        [orderNo.rows[0].n, req.user.sub,
         cart.rows[0].subtotal_cents, cart.rows[0].discount_cents,
         cart.rows[0].coupon_code, cart.rows[0].total_cents, cart.rows[0].currency,
         req.body.payment_method, req.ip, req.headers['user-agent'] || null]
      );

      // Cria order_items + calcula splits
      for (const it of items.rows) {
        const rate = it.is_platform_owned ? 1.0 : (it.custom_commission_rate ?? TAKE_RATE);
        const commission = it.is_platform_owned ? it.line_total_cents : Math.floor(it.line_total_cents * rate);
        const payout = it.line_total_cents - commission;
        const dl_token = crypto.randomUUID();
        const license_key = `CAS-${crypto.randomBytes(12).toString('hex').toUpperCase()}`;
        const snapshot = await c.query('SELECT fn_product_snapshot($1) AS s', [it.product_id]);
        await c.query(
          `INSERT INTO order_items
             (order_id, product_id, product_version_id, seller_id, is_platform_owned,
              quantity, unit_price_cents, line_total_cents, commission_rate,
              commission_cents, seller_payout_cents, license_key, download_token,
              download_expires_at, snapshot)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, NOW() + INTERVAL '365 days', $14::JSONB)`,
          [order.rows[0].id, it.product_id, null, it.seller_id || null,
           it.is_platform_owned, it.quantity, it.unit_price_cents, it.line_total_cents,
           rate, commission, payout, license_key, dl_token, snapshot.rows[0].s]
        );

        if (!it.is_platform_owned && it.asaas_wallet_id && payout > 0) {
          await c.query(
            `INSERT INTO asaas_splits (order_id, seller_id, wallet_id, fixed_value_cents)
             VALUES ($1,$2,$3,$4)`,
            [order.rows[0].id, it.seller_id, it.asaas_wallet_id, payout]
          );
        }
      }

      // limpa cart
      await c.query('DELETE FROM cart_items WHERE cart_id = $1', [cart.rows[0].id]);
      await c.query(`UPDATE carts SET items_count = 0, subtotal_cents = 0, discount_cents = 0,
                     total_cents = 0, coupon_code = NULL, updated_at = NOW() WHERE id = $1`,
                    [cart.rows[0].id]);

      return order.rows[0];
    });

    res.status(201).json({ ok: true, order: result });

    // Dispara payment-svc para criar cobranca Asaas (assincrono)
    setImmediate(async () => {
      try {
        await fetch(`http://127.0.0.1:${process.env.PORT_PAYMENT || 3016}/payments/asaas/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order_id: result.id }),
        });
      } catch (e) {
        log.error({ err: e.message, order_id: result.id }, '[payment.dispatch_failed]');
      }
    });
  })
);

// GET /orders - lista pedidos do usuario
router.get('/', asyncHandler(async (req, res) => {
  const r = await query(
    `SELECT o.id, o.order_number, o.status, o.payment_status, o.total_cents, o.currency,
            o.payment_method, o.created_at, o.paid_at,
            (SELECT json_agg(json_build_object('title', snapshot->>'title', 'cover', snapshot->>'cover_image_url'))
               FROM order_items WHERE order_id = o.id) AS items_preview
       FROM orders o WHERE o.buyer_user_id = $1
       ORDER BY o.created_at DESC LIMIT 50`,
    [req.user.sub]
  );
  res.json({ orders: r.rows });
}));

router.get('/:id', asyncHandler(async (req, res, next) => {
  const r = await query(
    `SELECT o.*,
       (SELECT json_agg(oi.*) FROM order_items oi WHERE oi.order_id = o.id) AS items
       FROM orders o WHERE o.id = $1 AND (o.buyer_user_id = $2 OR $3 = TRUE)`,
    [req.params.id, req.user.sub, ['admin','staff'].includes(req.user.role)]
  );
  if (!r.rows.length) return next(errorHandler.notFound('order_not_found'));
  res.json({ order: r.rows[0] });
}));

// POST /orders/:id/dispute - abre disputa
router.post('/:id/dispute',
  validate({ body: z.object({
    order_item_id: z.string().uuid(),
    reason_code: z.enum(['not_as_described','not_working','plagiarism','support_missing']),
    description: z.string().min(20).max(5000),
    requested_resolution: z.enum(['refund','replacement','partial_refund','support']),
  })}),
  asyncHandler(async (req, res) => {
    const r = await query(
      `INSERT INTO disputes (order_id, order_item_id, opened_by_user_id, against_seller_id,
                             reason_code, description, requested_resolution)
       SELECT $1, $2, $3, oi.seller_id, $4, $5, $6
         FROM order_items oi WHERE oi.id = $2
       RETURNING *`,
      [req.params.id, req.body.order_item_id, req.user.sub,
       req.body.reason_code, req.body.description, req.body.requested_resolution]
    );
    res.status(201).json({ dispute: r.rows[0] });
  })
);

module.exports = router;
