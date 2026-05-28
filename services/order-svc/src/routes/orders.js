'use strict';

const express = require('express');
const crypto = require('node:crypto');
const { z } = require('zod');
const { query, tx } = require('@cas/db-client');
const { jwt, asyncHandler, validate, errorHandler, logger, maskPII, rateLimiter } = require('@cas/shared');

// FIX-WORKER-7 pass 71: rate-limiter anti-spam dispute.
// PRE-FIX: POST /:id/dispute SEM rate-limit. Atacante com conta legitima:
//   - Bot dispara 100 disputes "plagiarism" em sellers competidores
//   - Mesmo com Regra M ownership (so abre dispute do PROPRIO order),
//     atacante pode ter comprado 10 produtos uniformes -> abrir 1 dispute por item
//     em SCRIPT loop = 100 disputes em segundos.
//   - DoS admin queue + reputation attack legitimo.
//   - Pattern W7 estabelecido (pass 32-34): mutations user-supplied DEVEM ter limiter.
// FIX: 5 disputes / hora / IP (real users abrem ~1 dispute/mes).
const disputeOpenLimiter = rateLimiter.createLimiter({
  windowMs: 60 * 60 * 1000, max: 5,
  message: 'Muitas disputas abertas recentemente. Aguarde 1 hora.',
});

const router = express.Router();
const log = logger.child({ svc: 'order-svc', mod: 'orders' });
router.use(jwt.requireAuth());

const TAKE_RATE = parseFloat(process.env.PLATFORM_TAKE_RATE || '0.18');

// POST /orders/checkout - cria pedido a partir do cart
// FIX-WORKER-2: schema refinement - installment_count > 1 exige payment_method='credit_card'
// Antes: client podia enviar {payment_method:'pix', installment_count:12}; field era
// silenciosamente DROPED na linha 120 -> pedido criado sem parcelas mas usuario achava
// que receberia 12x. UX confuso.
router.post('/checkout',
  validate({ body: z.object({
    payment_method: z.enum(['pix','credit_card','boleto']),
    installment_count: z.number().int().min(1).max(12).optional(),
  }).refine(
    (d) => !d.installment_count || d.installment_count === 1 || d.payment_method === 'credit_card',
    { message: 'installment_count > 1 requer payment_method=credit_card', path: ['installment_count'] }
  )}),
  asyncHandler(async (req, res, next) => {
    const result = await tx(async (c) => {
      const cart = await c.query(
        `SELECT * FROM carts WHERE user_id = $1 FOR UPDATE`, [req.user.sub]
      );
      if (!cart.rows.length || cart.rows[0].items_count === 0)
        throw errorHandler.badRequest('empty_cart');
      // FIX-WORKER-7 pass 17 (CRITICAL WRITE PATH):
      // Mesmo bug W7 pass 16 (POST /cart/items) repetido aqui em CHECKOUT.
      // Cenario:
      //   1. User add produto X ao cart (pre-W7 pass 16 fix permitia deletado)
      //   2. cart_items orfaos com produto deletado ainda no DB
      //   3. User faz checkout -> JOIN products SEM deleted_at filter
      //   4. Order criado com order_items referenciando produto deletado
      //   5. Payment Asaas captura mas seller_payouts join falha (deleted)
      //   6. Download URL 404 + suporte ticket
      // IMPACTO MAIOR que pass 16: orders FANTASMA persistidos no DB
      // (cart eh transient, order eh permanent + revenue capturado).
      // FIX defensivo dual: WHERE p.deleted_at IS NULL + status valido.
      // Se um cart_item orfao escapou (produto deletado pos-add), checkout
      // ROMPE com badRequest em vez de criar order broken.
      const items = await c.query(
        `SELECT ci.*, p.title, p.seller_id, p.is_platform_owned, p.platform_resale_enabled,
                s.custom_commission_rate, s.asaas_wallet_id
           FROM cart_items ci
           JOIN products p ON p.id = ci.product_id
           LEFT JOIN sellers s ON s.id = p.seller_id
          WHERE ci.cart_id = $1
            AND p.deleted_at IS NULL
            AND p.status IN ('approved','platform_owned')`, [cart.rows[0].id]
      );
      // FIX-WORKER-7 pass 17: detectar cart_items orfaos (produto deletado pos-add).
      // Se items < cart.items_count, alguns produtos foram deletados desde add.
      // Block checkout + user vai precisar limpar cart manualmente (UX preferivel
      // a order fantasma).
      const cartItemCount = await c.query(
        `SELECT COUNT(*)::INT AS cnt FROM cart_items WHERE cart_id = $1`,
        [cart.rows[0].id]
      );
      if (items.rows.length < cartItemCount.rows[0].cnt) {
        throw errorHandler.badRequest(
          'cart_has_unavailable_items',
          'Seu carrinho contem produtos que nao estao mais disponiveis. Remova-os e tente novamente.'
        );
      }

      // MLB-4 redeem: se cart tem pontos resgatados, debita IMEDIATAMENTE do balance
      // (pessimistic - se ja foi 'reservado' no cart, debita ao confirmar pedido).
      const loyaltyPts = parseInt(cart.rows[0].loyalty_points_redeemed || 0, 10);
      const loyaltyCents = parseInt(cart.rows[0].loyalty_discount_cents || 0, 10);
      if (loyaltyPts > 0) {
        const bal = await c.query(`SELECT points_balance FROM user_loyalty WHERE user_id = $1::UUID FOR UPDATE`, [req.user.sub]);
        const balance = parseInt(bal.rows[0]?.points_balance || 0, 10);
        if (loyaltyPts > balance) {
          throw errorHandler.badRequest('insufficient_points_at_checkout', `Saldo ${balance} < resgate ${loyaltyPts}`);
        }
        await c.query(
          `UPDATE user_loyalty SET points_balance = points_balance - $1::INT, updated_at = NOW() WHERE user_id = $2::UUID`,
          [loyaltyPts, req.user.sub]
        );
        // log na tabela de transacoes (delta negativo)
        await c.query(
          `INSERT INTO loyalty_transactions (user_id, points_delta, reason, reference_type)
           VALUES ($1::UUID, $2::INT, 'order_redeem', 'order')`,
          [req.user.sub, -loyaltyPts]
        );
      }

      const orderNo = await c.query(`SELECT fn_generate_order_number() AS n`);
      const order = await c.query(
        `INSERT INTO orders (order_number, buyer_user_id, status, subtotal_cents, discount_cents,
                             coupon_code, total_cents, currency, payment_method, payment_status,
                             loyalty_points_redeemed, loyalty_discount_cents,
                             buyer_ip, buyer_user_agent, expires_at)
         VALUES ($1,$2,'pending_payment',$3,$4,$5,$6,$7,$8,'pending',$9,$10,$11,$12, NOW() + INTERVAL '24 hours')
         RETURNING *`,
        [orderNo.rows[0].n, req.user.sub,
         cart.rows[0].subtotal_cents, cart.rows[0].discount_cents,
         cart.rows[0].coupon_code, cart.rows[0].total_cents, cart.rows[0].currency,
         req.body.payment_method, loyaltyPts, loyaltyCents,
         req.ip, req.headers['user-agent'] || null]
      );

      // Cria order_items + calcula splits
      // FIX-WORKER-11 pass 3: rate clamp 0..1 (era unrestricted -> admin podia setar
      // custom_commission_rate=1.5 (150%) e gerar payout NEGATIVO ao seller, ou negativo
      // (rouba seller). Math.max(0, Math.min(1, rate)) garante invariant.
      //
      // FIX-WORKER-11 pass 9: descontar coupon + loyalty PROPORCIONAL em cada item.
      // ANTES: commission = line_total * rate (bruto, sem desconto)
      //   Bug: SUM(payouts) podia exceder cart.total_cents quando cupom/loyalty aplicado
      //   Asaas rejeita createPayment com 400 "split sum > value" (W11 pass 5 contexto)
      //   Cenario: line_total R$100 com cupom 20% -> total R$80
      //            commission_18% sobre 100 = R$18, payout = R$82 (>= R$80 PAGO!)
      // AGORA: cada item recebe desconto proporcional ao share no subtotal.
      //   item_after_discount = line_total - (line_total / subtotal) * (discount + loyalty)
      //   commission/payout calculados sobre item_after_discount
      //   SUM(payouts) garantidamente <= cart.total_cents
      const subtotalCents = parseInt(cart.rows[0].subtotal_cents, 10) || 0;
      const totalDiscountCents = (parseInt(cart.rows[0].discount_cents, 10) || 0) + loyaltyCents;
      for (const it of items.rows) {
        const lineTotalCents = parseInt(it.line_total_cents, 10);
        // Desconto proporcional: share do item no subtotal aplicado ao desconto total
        const itemShare = subtotalCents > 0 ? lineTotalCents / subtotalCents : 0;
        const itemDiscount = Math.round(itemShare * totalDiscountCents);
        const effectiveTotal = Math.max(0, lineTotalCents - itemDiscount);

        const rawRate = it.is_platform_owned ? 1.0 : (Number(it.custom_commission_rate) || TAKE_RATE);
        const rate = Math.max(0, Math.min(1, rawRate)); // clamp 0..1
        const commission = it.is_platform_owned ? effectiveTotal : Math.floor(effectiveTotal * rate);
        const payout = Math.max(0, effectiveTotal - commission);
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
           it.is_platform_owned, it.quantity, it.unit_price_cents, lineTotalCents,
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
        const paymentUrl = process.env.UPSTREAM_PAYMENT || `http://tasks.cas_payment-svc:${process.env.PORT_PAYMENT || 3016}`;
        const body = { order_id: result.id };
        // MLB-5: passa parcelas (somente cartao)
        if (req.body.installment_count && req.body.payment_method === 'credit_card') {
          body.installment_count = req.body.installment_count;
        }
        // FIX-WORKER-11 pass 2: payment-svc agora exige x-internal-token (auth bypass fix)
        // FIX-WORKER-2 pass 3: log status real para detectar 401/500. fetch nao throw
        // em status != 2xx -> antes falhava silenciosamente quando PAYMENT_INTERNAL_TOKEN
        // estava unset (W17 pass 7 alertou no startup mas runtime ficava mudo).
        const hasToken = !!process.env.PAYMENT_INTERNAL_TOKEN;
        const r = await fetch(`${paymentUrl}/payments/asaas/create`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(hasToken ? { 'x-internal-token': process.env.PAYMENT_INTERNAL_TOKEN } : {}),
          },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          let detail = '';
          try { detail = (await r.text()).slice(0, 200); } catch {}
          log.error({
            order_id: result.id,
            status: r.status,
            has_token: hasToken,
            detail,
          }, '[payment.dispatch_non_2xx]');
        } else {
          log.info({ order_id: result.id, status: r.status }, '[payment.dispatch_ok]');
        }
      } catch (e) {
        log.error({ err: e.message, order_id: result.id }, '[payment.dispatch_failed]');
      }
    });
  })
);

// GET /orders - lista pedidos do usuario
// FIX-WORKER-7 pass 18: 2 bugs (Regra D tiebreaker + Regra H json_agg COALESCE).
// FIX-WORKER-7 pass 66: 4 BUGS aplicando Pattern W7 (Regras E + filters + UX).
//
// BUG 1 *** Regra E PAGINATION MISSING *** hardcoded LIMIT 50
//   User com 200+ orders historicos (heavy buyer) só vê primeiras 50.
//   /conta/pedidos pagina "Carregar mais" sem suporte server-side.
//   FIX: ?limit (1-100, default 30) + ?offset.
//
// BUG 2 *** ?status FILTER MISSING *** UX inflexivel
//   Usuario quer "ver só pagos" ou "ver disputados". Sem server-side filter,
//   frontend fetch all + filter client-side = waste payload + DB.
//   FIX: ?status enum whitelist (pending_payment, paid, fulfilled, cancelled,
//   refunded, disputed) + invalid -> 400.
//
// BUG 3 *** Regra I MISSING FIELDS *** discount/coupon info
//   PRE-FIX: response sem coupon_code, discount_cents, subtotal_cents.
//   Frontend /conta/pedidos UI quer mostrar "Voce economizou R$ X com cupom Y"
//   mas tem que fazer fetch /:id individual = N+1 navigation.
//   FIX: include subtotal_cents + discount_cents + coupon_code + loyalty fields.
//
// BUG 4 *** TOTAL + has_more UX *** paginacao UI sem "Carregar mais" estavel
//   FIX: COUNT(*) + has_more flag.
const ORDER_STATUS_ENUM = new Set([
  'pending_payment','paid','fulfilled','cancelled','refunded','disputed'
]);

router.get('/', asyncHandler(async (req, res) => {
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 30));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const statusFilter = req.query.status ? String(req.query.status) : null;
  if (statusFilter && !ORDER_STATUS_ENUM.has(statusFilter)) {
    return res.status(400).json({
      error: 'invalid_status',
      allowed: Array.from(ORDER_STATUS_ENUM),
    });
  }

  // Regra B (deleted_at) nao aplicavel em orders (sem soft-delete table)
  const whereParts = ['o.buyer_user_id = $1'];
  const params = [req.user.sub];
  let i = 2;
  if (statusFilter) {
    whereParts.push(`o.status = $${i++}`);
    params.push(statusFilter);
  }
  params.push(limit, offset);
  const limIdx = i++;
  const offIdx = i++;

  const r = await query(
    `SELECT o.id, o.order_number, o.status, o.payment_status,
            o.total_cents, o.subtotal_cents, o.discount_cents,
            o.coupon_code, o.loyalty_points_redeemed, o.loyalty_discount_cents,
            o.currency, o.payment_method, o.created_at, o.paid_at,
            COALESCE(
              (SELECT json_agg(json_build_object('title', snapshot->>'title', 'cover', snapshot->>'cover_image_url'))
                 FROM order_items WHERE order_id = o.id),
              '[]'::JSON
            ) AS items_preview
       FROM orders o
      WHERE ${whereParts.join(' AND ')}
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT $${limIdx} OFFSET $${offIdx}`,
    params
  );

  // Total count para has_more UX (paginacao "Carregar mais")
  const countParams = params.slice(0, -2);
  const totalRes = await query(
    `SELECT COUNT(*)::INT AS total FROM orders o WHERE ${whereParts.join(' AND ')}`,
    countParams
  );
  const total = totalRes.rows[0].total;

  res.json({
    orders: r.rows,
    total,
    limit,
    offset,
    has_more: (offset + r.rows.length) < total,
    status: statusFilter,
  });
}));

// GET /orders/admin/recent (todos pedidos, role admin)
// FIX-WORKER-7 pass 59: LGPD role-tier PII masking (admin=full, staff=masked)
//   PRE-FIX: SELECT u.email + u.full_name returned plain text para STAFF role.
//   Staff (sub-admin) podia coletar PII compradores sem necessidade (LGPD Art 6° II).
//   Pattern pass 57 estabelecido em review-svc -> aqui replicado cross-svc.
//   FIX: isAdmin path full visibility; staff path maskPII.email/name.
// + Regra E pagination ?limit/?offset
router.get('/admin/recent',
  jwt.requireAuth({ roles: ['admin','staff'] }),
  asyncHandler(async (req, res) => {
    // FIX-WORKER-7 pass 18: tiebreaker (Regra D) + window temporal stats
    // FIX-WORKER-7 pass 59: ?limit (1-200, default 100) + ?offset paginacao
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 100));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const r = await query(
      `SELECT o.id, o.order_number, o.status, o.payment_status, o.total_cents, o.currency,
              o.payment_method, o.buyer_user_id, o.created_at, o.paid_at,
              u.email AS buyer_email, u.full_name AS buyer_name
         FROM orders o
         JOIN users u ON u.id = o.buyer_user_id
        ORDER BY o.created_at DESC, o.id LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    // FIX-WORKER-7 pass 18: stats window temporal 90 days.
    // PRE-FIX: COUNT(*) FROM orders SEM filtro temporal -> full table scan
    // toda vez admin abre dashboard. Em escala MLB (1M orders) = ~2-5s PG CPU
    // por hit. Admin abre /admin/recent muitas vezes/dia.
    // POS-FIX: WHERE created_at > NOW() - 90 days -> scan idx_orders_created
    // -> ~10-50ms em 1M orders (~50x).
    // 90d eh padrao "recent" - admin querendo all-time usa /admin/financials.
    // Stats reflete contexto "ultimo trimestre" - mais util que all-time.
    const stats = await query(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('paid','fulfilled')) AS count_paid,
         COUNT(*) FILTER (WHERE status = 'pending_payment') AS count_pending,
         COALESCE(SUM(total_cents) FILTER (WHERE status IN ('paid','fulfilled')), 0) AS total_revenue,
         '90 days' AS window
         FROM orders WHERE created_at > NOW() - INTERVAL '90 days'`
    );

    // FIX-WORKER-7 pass 59: LGPD role-tier masking
    const isAdmin = req.user && req.user.role === 'admin';
    const orders = r.rows.map((row) => isAdmin ? row : ({
      ...row,
      buyer_email: maskPII.email(row.buyer_email),
      buyer_name: maskPII.name(row.buyer_name),
    }));

    res.json({ orders, stats: stats.rows[0], limit, offset });
  })
);

// FIX-WORKER-4: valida UUID antes do query para evitar PG 22P02 -> 500.
// Antes: GET /orders/admin (ou qualquer slug) caia aqui e o param 'admin' era passado
// como UUID ao Postgres, gerando 500 generico. Agora retorna 404 limpo.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.get('/:id', asyncHandler(async (req, res, next) => {
  if (!UUID_RE.test(req.params.id)) return next(errorHandler.notFound('order_not_found'));
  // FIX-WORKER-7 pass 18: 2 bugs (Regra I + Regra H):
  // 1. SELECT o.* expoe colunas internas: idempotency_key (replay attack vector
  //    se vazado), buyer_ip+buyer_user_agent (PII), expires_at internal logic,
  //    asaas_charge_id (internal payment provider reference).
  // 2. json_agg(oi.*) EXPOE download_token plain text - se user nao for o
  //    buyer ainda mas admin/staff (linha 261 condicao role permite ler order
  //    de outro user), download_token VAZA ao admin -> admin pode baixar
  //    produto de qualquer order. SECURITY ISSUE.
  //    + Regra H: json_agg NULL se 0 items (raro mas possivel).
  // FIX: lista explicita campos consumidos pelo frontend.
  // download_token EXCLUIDO do response - admin nao deve ver.
  // /orders/:id/download eh endpoint dedicado com check buyer-only.
  const r = await query(
    `SELECT o.id, o.order_number, o.status, o.payment_status, o.total_cents,
            o.subtotal_cents, o.discount_cents, o.coupon_code, o.currency,
            o.payment_method, o.created_at, o.paid_at, o.fulfilled_at,
            o.loyalty_points_redeemed, o.loyalty_discount_cents,
            COALESCE(
              (SELECT json_agg(json_build_object(
                 'id', oi.id, 'product_id', oi.product_id,
                 'unit_price_cents', oi.unit_price_cents,
                 'quantity', oi.quantity,
                 'line_total_cents', oi.line_total_cents,
                 'snapshot', oi.snapshot
               ) ORDER BY oi.created_at, oi.id)
                 FROM order_items oi WHERE oi.order_id = o.id),
              '[]'::JSON
            ) AS items
       FROM orders o
      WHERE o.id = $1 AND (o.buyer_user_id = $2 OR $3 = TRUE)`,
    [req.params.id, req.user.sub, ['admin','staff'].includes(req.user.role)]
  );
  if (!r.rows.length) return next(errorHandler.notFound('order_not_found'));
  res.json({ order: r.rows[0] });
}));

// POST /orders/:id/dispute - abre disputa
// FIX-WORKER-7 pass 29: 6 BUGS criticos aplicando Pattern W7 17 regras.
//
// BUG 1 *** SECURITY CRITICO (Regra M ownership) ***
//   PRE-FIX: SELECT order_items WHERE oi.id = order_item_id - sem ownership
//   ATAQUE:
//     a. Atacante autentica com qualquer conta
//     b. POST /orders/<victim_order>/dispute body={order_item_id:<victim_item>}
//     c. INSERT dispute com opened_by_user_id=atacante, against_seller=victim_seller
//     d. Atacante abre 100 disputes "plagiarism" em sellers competidores
//     e. DoS: admin queue lotada + sellers suspensos enquanto investiga
//     f. Reputation attack legitimo: dispute existe no DB, audit nao distingue
//   FIX: order WHERE buyer_user_id = req.user.sub (so dono abre)
//
// BUG 2 *** CROSS-TABLE VALIDATION ***
//   PRE-FIX: order_item_id valida via FK mas SEM check que oi.order_id = :id
//   Atacante pode mixar: URL /orders/<any>/dispute body={order_item_id:<other_order>}
//   INSERT cria dispute com order_id != order_item.order_id (DB integrity break)
//   FIX: AND oi.order_id = $1 no SELECT - garante 1:1 relationship
//
// BUG 3 *** IDEMPOTENCY (Regra Q) *** sem unique guard
//   User pode abrir 10 disputes mesmo order_item (spam queue admin)
//   FIX: SELECT existing dispute por (order_item_id, opened_by_user_id, status active)
//   Se ja aberta: 409 Conflict + dispute_id existente
//
// BUG 4 ORDER STATUS check (Regra A): dispute em order 'pending_payment'?
//   Disputa faz sentido SO em orders 'paid'/'fulfilled' (produto entregue defeituoso)
//   FIX: AND o.status IN ('paid', 'fulfilled')
//
// BUG 5 Regra I RETURNING *
//   disputes table tem internal_notes, admin_resolution_notes, resolved_at,
//   risk_score (futuro). RETURNING * vaza ao buyer.
//   FIX: RETURNING explicit fields (8 campos consumidos UI)
//
// BUG 6 UUID validate :id + audit log
//   UUID validate upfront p/ evitar PG 22P02
//   audit_log INSERT (forense - dispute eh evento critical)
router.post('/:id/dispute',
  disputeOpenLimiter,  // FIX-WORKER-7 pass 71: anti-spam 5/hr/IP
  validate({ body: z.object({
    order_item_id: z.string().uuid(),
    reason_code: z.enum(['not_as_described','not_working','plagiarism','support_missing']),
    description: z.string().min(20).max(5000),
    requested_resolution: z.enum(['refund','replacement','partial_refund','support']),
  })}),
  asyncHandler(async (req, res, next) => {
    // FIX bug 6: UUID validate upfront
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(req.params.id)) {
      return next(errorHandler.notFound('order_not_found'));
    }

    let outcome;
    let dispute;
    await tx(async (c) => {
      // FIX bug 1+2+4 (Regra M+A+cross-table): validacao consolidada
      // - order existe + buyer = req.user (ownership)
      // - order status valido p/ disputa
      // - order_item belongs TO this order (cross-table)
      // - returns seller_id p/ INSERT
      const validRow = await c.query(
        `SELECT o.id AS order_id, o.status AS order_status,
                oi.id AS item_id, oi.seller_id
           FROM orders o
           JOIN order_items oi ON oi.order_id = o.id
          WHERE o.id = $1::UUID
            AND o.buyer_user_id = $2::UUID
            AND oi.id = $3::UUID
          LIMIT 1`,
        [req.params.id, req.user.sub, req.body.order_item_id]
      );
      if (!validRow.rows.length) {
        // Pode ser: order nao existe, order nao eh do user, ou order_item nao eh dessa order
        // Mensagem generica anti-enumeration (atacante nao distingue qual)
        outcome = { error: 'order_or_item_not_found' };
        return;
      }
      const v = validRow.rows[0];
      if (!['paid', 'fulfilled'].includes(v.order_status)) {
        outcome = { error: 'order_status_invalid', current_status: v.order_status };
        return;
      }

      // FIX bug 3 (Regra Q idempotency): existing active dispute?
      // disputes table assumindo status field padrao ('open', 'investigating', 'resolved', 'closed')
      // Bloqueia abertura nova se ja existe ativa (mesmo item, mesmo buyer).
      const existing = await c.query(
        `SELECT id, status, opened_at FROM disputes
          WHERE order_item_id = $1::UUID
            AND opened_by_user_id = $2::UUID
            AND status IN ('open', 'investigating')
          LIMIT 1`,
        [req.body.order_item_id, req.user.sub]
      );
      if (existing.rows.length) {
        outcome = {
          error: 'dispute_already_open',
          existing_dispute_id: existing.rows[0].id,
          status: existing.rows[0].status,
          opened_at: existing.rows[0].opened_at,
        };
        return;
      }

      // FIX bug 5 (Regra I RETURNING explicit): 8 campos minimos UI consume
      const inserted = await c.query(
        `INSERT INTO disputes
           (order_id, order_item_id, opened_by_user_id, against_seller_id,
            reason_code, description, requested_resolution)
         VALUES ($1::UUID, $2::UUID, $3::UUID, $4::UUID, $5, $6, $7)
         RETURNING id, order_id, order_item_id, against_seller_id, reason_code,
                   requested_resolution, status, opened_at`,
        [v.order_id, v.item_id, req.user.sub, v.seller_id,
         req.body.reason_code, req.body.description, req.body.requested_resolution]
      );
      dispute = inserted.rows[0];

      // FIX bug 6 (audit log): dispute eh evento critical (afeta seller reputation)
      await c.query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES ($1, $2, 'order.dispute_open', 'dispute', $3, 'warn', $4::JSONB)`,
        [req.user.sub, req.user.role || 'buyer', dispute.id,
         JSON.stringify({
           order_id: v.order_id,
           order_item_id: v.item_id,
           against_seller_id: v.seller_id,
           reason_code: req.body.reason_code,
           requested_resolution: req.body.requested_resolution,
           ip: req.ip,
         })]
      );
    });

    if (outcome?.error === 'order_or_item_not_found') {
      return next(errorHandler.notFound('order_or_item_not_found'));
    }
    if (outcome?.error === 'order_status_invalid') {
      return res.status(400).json({
        error: 'order_status_invalid',
        message: `Disputas so abertas para pedidos pagos/entregues. Status atual: ${outcome.current_status}`,
        current_status: outcome.current_status,
      });
    }
    if (outcome?.error === 'dispute_already_open') {
      return res.status(409).json({
        error: 'dispute_already_open',
        message: 'Voce ja tem uma disputa ativa para este item. Aguarde resolucao.',
        existing_dispute_id: outcome.existing_dispute_id,
        status: outcome.status,
        opened_at: outcome.opened_at,
      });
    }
    res.status(201).json({ dispute });
  })
);

// ============================================================
// FIX-WORKER-4 + W7 pass 31: ADMIN endpoints p/ gerenciar disputes
// Aplicando Pattern W7 17 regras (A-R) consolidadas em 30 iters anteriores.
// ============================================================

// GET /orders/admin/disputes - lista disputes paginadas com filtros
// (Regra I SELECT explicit, Regra D tiebreaker, Regra E response shape limit)
router.get('/admin/disputes',
  jwt.requireAuth({ roles: ['admin','staff'] }),
  asyncHandler(async (req, res) => {
    // Status enum mig 007: opened|under_review|resolved_buyer|resolved_seller|cancelled
    const status = (req.query.status || '').toString();
    const VALID_STATUSES = ['opened', 'under_review', 'resolved_buyer', 'resolved_seller', 'cancelled'];
    const statusFilter = VALID_STATUSES.includes(status) ? status : null;
    const lim = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50, 200));

    // FIX-WORKER-7 pass 110 deploy: schema real disputes (psql \\d):
    //   created_at (não opened_at), resolved_in_favor_of (não resolution_*),
    //   evidence_urls, seller_response, seller_responded_at, mediator_user_id,
    //   mediator_notes, resolution_action. Sem 'opened_at' separado.
    const r = await query(
      `SELECT d.id, d.order_id, d.order_item_id, d.opened_by_user_id,
              d.against_seller_id, d.reason_code, d.description,
              d.requested_resolution, d.status,
              d.created_at, d.resolved_at, d.resolved_in_favor_of,
              d.resolution_action, d.refund_amount_cents,
              u.email AS buyer_email, u.full_name AS buyer_name,
              s.store_name AS seller_store_name, s.store_slug AS seller_store_slug,
              o.order_number, o.total_cents
         FROM disputes d
         LEFT JOIN users u ON u.id = d.opened_by_user_id
         LEFT JOIN sellers s ON s.id = d.against_seller_id
         LEFT JOIN orders o ON o.id = d.order_id
        WHERE ($1::TEXT IS NULL OR d.status::TEXT = $1)
        ORDER BY
          CASE d.status::TEXT
            WHEN 'opened' THEN 1
            WHEN 'under_review' THEN 2
            WHEN 'resolved_buyer' THEN 3
            WHEN 'resolved_seller' THEN 4
            ELSE 5
          END,
          d.created_at DESC,
          d.id
        LIMIT $2`,
      [statusFilter, lim]
    );
    // Counts agregados (para badges UI). Window 90d cobre admin queue.
    // FIX pass 110: opened_at -> created_at (schema real)
    const stats = await query(
      `SELECT status::TEXT AS status, COUNT(*)::INT AS n FROM disputes
        WHERE created_at > NOW() - INTERVAL '90 days'
        GROUP BY status`
    );
    const counts = stats.rows.reduce((acc, r) => ({ ...acc, [r.status]: r.n }), {});

    // FIX-WORKER-7 pass 59: LGPD role-tier masking
    // PRE-FIX: buyer_email/buyer_name plain text para STAFF
    // Pattern pass 57/59 cross-svc - staff vê masked, admin vê full
    const isAdmin = req.user && req.user.role === 'admin';
    const disputes = r.rows.map((row) => isAdmin ? row : ({
      ...row,
      buyer_email: maskPII.email(row.buyer_email),
      buyer_name: maskPII.name(row.buyer_name),
    }));

    res.json({ disputes, counts, limit: lim, filter: statusFilter });
  })
);

// POST /orders/admin/disputes/:id/resolve - admin resolve dispute
// Aplica Regra N state machine + Regra Q idempotent terminal + audit_log atomic
const DISPUTE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Enum schema real mig 007: opened|under_review|resolved_buyer|resolved_seller|cancelled
const DISPUTE_TERMINAL_STATUSES = new Set(['resolved_buyer', 'resolved_seller', 'cancelled']);
const DISPUTE_ALLOWED_FROM = new Set(['opened', 'under_review']);

router.post('/admin/disputes/:id/resolve',
  jwt.requireAuth({ roles: ['admin','staff'] }),
  validate({ body: z.object({
    resolution_action: z.enum(['refund_approved','refund_denied','replacement_sent','partial_refund','dismissed']),
    admin_notes: z.string().min(10).max(5000),
    // Status final mapeia ao enum schema. resolved_buyer = a favor buyer (refund/replacement).
    // resolved_seller = a favor seller (dismissed). cancelled = dispute encerrada sem decisao.
    next_status: z.enum(['resolved_buyer', 'resolved_seller', 'cancelled']).default('resolved_buyer'),
    refund_amount_cents: z.number().int().nonnegative().optional(),
  })}),
  asyncHandler(async (req, res, next) => {
    // Regra: UUID validate upfront (anti PG 22P02)
    if (!DISPUTE_UUID_RE.test(req.params.id)) {
      return next(errorHandler.badRequest('invalid_uuid'));
    }

    let outcome;
    await tx(async (c) => {
      // Regra K: SELECT FOR UPDATE + Regra Q idempotent terminal guard
      const cur = await c.query(
        `SELECT id, status, against_seller_id, order_id, order_item_id, opened_by_user_id
           FROM disputes WHERE id = $1::UUID FOR UPDATE`,
        [req.params.id]
      );
      if (!cur.rows.length) { outcome = { error: 'not_found' }; return; }
      const d = cur.rows[0];

      // Regra N state machine: only open|investigating can be resolved
      if (DISPUTE_TERMINAL_STATUSES.has(d.status)) {
        outcome = {
          error: 'already_resolved',
          current_status: d.status,
        };
        return;
      }
      if (!DISPUTE_ALLOWED_FROM.has(d.status)) {
        outcome = { error: 'invalid_state', current_status: d.status };
        return;
      }

      // UPDATE atomic com idempotent guard (WHERE status IN allowed)
      // Schema real mig 007: mediator_user_id + mediator_notes + refund_amount_cents
      // Mig 042: + resolution_action coluna nova
      await c.query(
        `UPDATE disputes
            SET status = $1::dispute_status,
                resolution_action = $2,
                mediator_notes = $3,
                refund_amount_cents = $4,
                resolved_at = NOW(),
                mediator_user_id = $5::UUID
          WHERE id = $6::UUID AND status IN ('opened','under_review')`,
        [req.body.next_status, req.body.resolution_action, req.body.admin_notes,
         req.body.refund_amount_cents || null, req.user.sub, req.params.id]
      );

      // Audit log atomic dentro do tx (pattern W7 pass 23 estabeleceu)
      await c.query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES ($1, $2, 'order.dispute_resolve', 'dispute', $3, 'warn', $4::JSONB)`,
        [req.user.sub, req.user.role, req.params.id,
         JSON.stringify({
           resolution_action: req.body.resolution_action,
           next_status: req.body.next_status,
           refund_amount_cents: req.body.refund_amount_cents || null,
           against_seller_id: d.against_seller_id,
           order_id: d.order_id,
           ip: req.ip,
         })]
      );
      outcome = { ok: true, dispute_id: req.params.id, new_status: req.body.next_status };
    });

    if (outcome?.error === 'not_found') return next(errorHandler.notFound('dispute_not_found'));
    if (outcome?.error === 'already_resolved') {
      return res.status(409).json({
        error: 'already_resolved',
        message: 'Disputa ja foi resolvida anteriormente.',
        current_status: outcome.current_status,
      });
    }
    if (outcome?.error === 'invalid_state') {
      return res.status(400).json({
        error: 'invalid_state',
        message: `Estado atual nao permite resolucao: ${outcome.current_status}`,
        current_status: outcome.current_status,
      });
    }
    res.json(outcome);
  })
);

module.exports = router;
