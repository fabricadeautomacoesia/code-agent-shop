'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const express = require('express');
const crypto = require('node:crypto');
const { z } = require('zod');
const { query, tx } = require('@cas/db-client');
const { logger, sanitize, errorHandler, asyncHandler, validate, jwt } = require('@cas/shared');
const asaas = require('./asaas');

const log = logger.child({ svc: 'payment-svc' });
const app = express();
const PORT = parseInt(process.env.PORT_PAYMENT || '3016', 10);

app.disable('x-powered-by');

// raw body para validar assinatura no webhook
app.use('/payments/asaas/webhook', express.raw({ type: '*/*', limit: '2mb' }));
app.use(express.json({ limit: '512kb' }));
app.use(sanitize.middleware());

app.get('/health', (_req, res) => res.json({
  ok: true, svc: 'payment-svc',
  asaas: { configured: !!process.env.ASAAS_API_KEY, url: process.env.ASAAS_API_URL }
}));

// POST /payments/asaas/create - chamado pelo order-svc apos checkout
app.post('/payments/asaas/create',
  validate({ body: z.object({ order_id: z.string().uuid() }) }),
  asyncHandler(async (req, res, next) => {
    const o = await query(
      `SELECT o.*, u.email, u.full_name, u.cpf_cnpj, u.phone_e164
         FROM orders o JOIN users u ON u.id = o.buyer_user_id
        WHERE o.id = $1`, [req.body.order_id]
    );
    if (!o.rows.length) return next(errorHandler.notFound('order_not_found'));
    const order = o.rows[0];
    if (order.payment_status !== 'pending') return next(errorHandler.badRequest('payment_not_pending'));

    // 1. cria/usa customer Asaas (cache no users.metadata.asaas_customer_id)
    const u = await query('SELECT metadata FROM users WHERE id = $1', [order.buyer_user_id]);
    let customerId = u.rows[0]?.metadata?.asaas_customer_id;
    if (!customerId) {
      const cust = await asaas.createCustomer({
        name: order.full_name,
        email: order.email,
        cpfCnpj: order.cpf_cnpj || '00000000000',
        phone: order.phone_e164,
        externalReference: order.buyer_user_id,
      });
      customerId = cust.id;
      await query(
        `UPDATE users SET metadata = metadata || $1::JSONB WHERE id = $2`,
        [JSON.stringify({ asaas_customer_id: customerId }), order.buyer_user_id]
      );
    }

    // 2. carrega splits
    const splitRows = await query(
      `SELECT wallet_id, fixed_value_cents FROM asaas_splits WHERE order_id = $1`,
      [order.id]
    );
    const split = splitRows.rows.map((s) => ({
      walletId: s.wallet_id,
      fixedValue: Math.round(s.fixed_value_cents) / 100,
    }));

    // 3. mapear billing type
    const billingMap = { pix: 'PIX', credit_card: 'CREDIT_CARD', boleto: 'BOLETO' };
    const dueDate = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);

    const payment = await asaas.createPayment({
      customer: customerId,
      billingType: billingMap[order.payment_method],
      value: order.total_cents / 100,
      dueDate,
      description: `Pedido ${order.order_number} - Code & Agent Shop`,
      externalReference: order.id,
      split,
    });

    // 4. campos extras (PIX QR Code, boleto URL)
    let pix = null;
    if (order.payment_method === 'pix') {
      try { pix = await asaas.getPixQrCode(payment.id); } catch (e) { log.warn({ err: e.message }, '[pix.qr.fail]'); }
    }

    await query(
      `UPDATE orders SET asaas_payment_id = $1, asaas_invoice_url = $2,
                         asaas_pix_qrcode = $3, asaas_pix_copy_paste = $4,
                         asaas_boleto_url = $5, payment_status = 'authorized'
        WHERE id = $6`,
      [payment.id, payment.invoiceUrl || null,
       pix?.encodedImage || null, pix?.payload || null,
       payment.bankSlipUrl || null, order.id]
    );

    res.json({
      ok: true,
      asaas_payment_id: payment.id,
      invoice_url: payment.invoiceUrl,
      pix_qrcode: pix?.encodedImage,
      pix_copy_paste: pix?.payload,
      boleto_url: payment.bankSlipUrl,
      due_date: dueDate,
    });
  })
);

// POST /payments/asaas/webhook - recebe eventos Asaas
app.post('/payments/asaas/webhook', asyncHandler(async (req, res) => {
  const raw = req.body.toString('utf8');
  // Assinatura: header asaas-access-token (configurar igual ASAAS_WEBHOOK_SECRET)
  const sig = req.headers['asaas-access-token'];
  const secret = process.env.ASAAS_WEBHOOK_SECRET;
  const valid = !secret || sig === secret;

  let data;
  try { data = JSON.parse(raw); } catch { return res.status(400).json({ error: 'invalid_json' }); }

  // Idempotencia
  const exists = await query('SELECT 1 FROM asaas_webhook_events WHERE asaas_event_id = $1', [data.id]);
  if (exists.rows.length) return res.json({ ok: true, duplicate: true });

  await query(
    `INSERT INTO asaas_webhook_events (event_type, asaas_event_id, asaas_payment_id, payload, signature_valid)
     VALUES ($1, $2, $3, $4::JSONB, $5)`,
    [data.event, data.id || null, data.payment?.id || null, JSON.stringify(data), valid]
  );

  res.json({ ok: true });

  // Processa assincrono
  setImmediate(() => processWebhookEvent(data).catch((e) => log.error({ err: e.message }, '[webhook.process.fail]')));
}));

async function processWebhookEvent(evt) {
  const paymentId = evt.payment?.id;
  if (!paymentId) return;

  const r = await query('SELECT id, buyer_user_id, payment_status FROM orders WHERE asaas_payment_id = $1', [paymentId]);
  if (!r.rows.length) return;
  const order = r.rows[0];

  const map = {
    PAYMENT_RECEIVED:    { ps: 'captured', os: 'paid', paid_at: true },
    PAYMENT_CONFIRMED:   { ps: 'captured', os: 'paid', paid_at: true },
    PAYMENT_REFUNDED:    { ps: 'refunded', os: 'refunded' },
    PAYMENT_OVERDUE:     { ps: 'failed',   os: 'expired' },
    PAYMENT_DELETED:     { ps: 'failed',   os: 'cancelled' },
    PAYMENT_REFUND_FAILED:{ ps: 'failed' },
  };
  const action = map[evt.event];
  if (!action) return;

  await tx(async (c) => {
    const cols = [];
    const vals = [];
    let i = 1;
    if (action.ps) { cols.push(`payment_status = $${i++}`); vals.push(action.ps); }
    if (action.os) { cols.push(`status = $${i++}`); vals.push(action.os); }
    if (action.paid_at) { cols.push(`paid_at = NOW()`); }
    vals.push(order.id);
    await c.query(`UPDATE orders SET ${cols.join(', ')}, updated_at = NOW() WHERE id = $${i}`, vals);

    if (action.paid_at) {
      // marca splits como processed
      await c.query(`UPDATE asaas_splits SET status = 'processed', processed_at = NOW() WHERE order_id = $1`, [order.id]);
      // MLB-4: Loyalty earn - 1 ponto por R$ 1 do total pago (Gold +20%, Platinum +50%)
      try {
        const totRow = await c.query(`SELECT total_cents FROM orders WHERE id = $1`, [order.id]);
        const totalCents = totRow.rows[0]?.total_cents || 0;
        const tierRow = await c.query(`SELECT tier FROM user_loyalty WHERE user_id = $1`, [order.buyer_user_id]);
        const curTier = tierRow.rows[0]?.tier || 'starter';
        const mult = curTier === 'platinum' ? 1.5 : (curTier === 'gold' ? 1.2 : 1.0);
        const basePts = Math.floor(totalCents / 100); // R$1 = 1 pt
        const pts = Math.floor(basePts * mult);
        if (pts > 0) {
          await c.query(
            `INSERT INTO user_loyalty (user_id, points_balance, points_lifetime)
             VALUES ($1, $2, $2)
             ON CONFLICT (user_id) DO UPDATE SET
               points_balance = user_loyalty.points_balance + $2,
               points_lifetime = user_loyalty.points_lifetime + $2,
               updated_at = NOW()`,
            [order.buyer_user_id, pts]
          );
          await c.query(
            `INSERT INTO loyalty_transactions (user_id, points_delta, reason, reference_type, reference_id)
             VALUES ($1, $2, 'order_paid', 'order', $3::text)`,
            [order.buyer_user_id, pts, order.id]
          );
          // recalcula tier
          const lt = await c.query(`SELECT points_lifetime FROM user_loyalty WHERE user_id = $1`, [order.buyer_user_id]);
          const lifetime = Number(lt.rows[0].points_lifetime);
          const newTier = lifetime >= 3000 ? 'platinum' : (lifetime >= 500 ? 'gold' : 'starter');
          await c.query(`UPDATE user_loyalty SET tier = $1 WHERE user_id = $2`, [newTier, order.buyer_user_id]);
        }
      } catch (e) {
        log.error({ err: e.message, order_id: order.id }, '[loyalty.earn.fail]');
      }
      // contadores de produto e seller
      await c.query(
        `UPDATE products p SET sales_count = sales_count + oi.quantity,
                               revenue_cents_total = revenue_cents_total + oi.line_total_cents
           FROM order_items oi WHERE oi.order_id = $1 AND oi.product_id = p.id`, [order.id]
      );
      await c.query(
        `UPDATE sellers s SET total_sales = total_sales + 1,
                              total_revenue_cents = total_revenue_cents + oi.seller_payout_cents
           FROM order_items oi WHERE oi.order_id = $1 AND oi.seller_id = s.id`, [order.id]
      );
      // notification ao buyer
      await c.query(
        `INSERT INTO notifications (user_id, channel, template_code, title, body, priority)
         VALUES ($1, 'email', 'order_paid', 'Pagamento confirmado', 'Seu pagamento foi confirmado. Acesse seus produtos.', 0)`,
        [order.buyer_user_id]
      );
      // notification aos sellers
      const sellers = await c.query(
        `SELECT DISTINCT s.user_id, p.title, oi.seller_payout_cents
           FROM order_items oi JOIN sellers s ON s.id = oi.seller_id JOIN products p ON p.id = oi.product_id
          WHERE oi.order_id = $1 AND oi.seller_id IS NOT NULL`, [order.id]
      );
      for (const seller of sellers.rows) {
        await c.query(
          `INSERT INTO notifications (user_id, channel, template_code, title, body, payload)
           VALUES ($1, 'email', 'seller_new_sale', 'Nova venda', $2, $3::JSONB)`,
          [seller.user_id, `Voce vendeu "${seller.title}". Liquido: R$ ${(seller.seller_payout_cents/100).toFixed(2)}`,
           JSON.stringify({ title: seller.title, payout: (seller.seller_payout_cents/100).toFixed(2) })]
        );
      }
    }
  });
  log.info({ event: evt.event, order_id: order.id }, '[webhook.processed]');
}

// POST /payments/payouts/:id/process - admin manda processar transfer
app.post('/payments/payouts/:id/process',
  jwt.requireAuth({ roles: ['admin','staff'] }),
  asyncHandler(async (req, res, next) => {
    const p = await query(
      `SELECT p.*, s.asaas_wallet_id FROM seller_payouts p
        JOIN sellers s ON s.id = p.seller_id WHERE p.id = $1 AND p.status = 'approved'`,
      [req.params.id]
    );
    if (!p.rows.length) return next(errorHandler.notFound('payout_not_approved'));
    if (!p.rows[0].asaas_wallet_id) return next(errorHandler.badRequest('seller_wallet_missing'));
    const t = await asaas.createTransfer({
      wallet: p.rows[0].asaas_wallet_id,
      value: p.rows[0].amount_cents / 100,
      description: `Saque seller ${p.rows[0].seller_id}`,
    });
    await query(
      `UPDATE seller_payouts SET status = 'paid', paid_at = NOW(), asaas_transfer_id = $1 WHERE id = $2`,
      [t.id, req.params.id]
    );
    res.json({ ok: true, transfer: t });
  })
);

app.use((req, res) => res.status(404).json({ error: 'route_not_found' }));
app.use(errorHandler.errorMiddleware);

const server = app.listen(PORT, () => log.info({ port: PORT }, '[payment-svc] listening'));
['SIGINT','SIGTERM'].forEach((s) => process.on(s, () => server.close(() => process.exit(0))));
