'use strict';

const express = require('express');
const crypto = require('node:crypto');
const { z } = require('zod');
const { query, tx } = require('@cas/db-client');
const { jwt, asyncHandler, validate, errorHandler, logger, maskPII, rateLimiter, cache, mask, notifCache } = require('@cas/shared');

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

// FIX-WORKER-2 pass 196 (CRITICAL): rate-limit /orders/checkout.
// PRE-FIX: zero limit. Atacante autenticado pode spam POST /checkout
// criando 1000 orders pending em segundos:
//   - PG pool exhaustion (cada checkout faz tx longa - SELECT FOR UPDATE +
//     ~10 queries)
//   - Asaas createPayment dispara em paralelo (assincrono setImmediate
//     linha 188) -> rate-limit upstream + cost extra
//   - DB enche de orders pending_payment orfas (cron cleanup hum hum)
//   - User experience: 1 checkout serializa toda a app
// FIX: 20 checkouts/hora/user (real user faz <5/dia normalmente).
// Pattern V8 W7: high-impact mutations DEVEM ter limiter.
// Real users overage: limite generoso 20/h ainda permite poweruser
// completar carrinhos multiplos legitimos (impulse buys + reset).
const checkoutLimiter = rateLimiter.createLimiter({
  windowMs: 60 * 60 * 1000, max: 20,
  message: 'Muitas tentativas de checkout. Aguarde alguns minutos.',
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
  checkoutLimiter,  // FIX-WORKER-2 pass 196: rate-limit 20/h/user (anti-spam DoS)
  validate({ body: z.object({
    payment_method: z.enum(['pix','credit_card','boleto']),
    installment_count: z.number().int().min(1).max(12).optional(),
  }).refine(
    (d) => !d.installment_count || d.installment_count === 1 || d.payment_method === 'credit_card',
    { message: 'installment_count > 1 requer payment_method=credit_card', path: ['installment_count'] }
  )}),
  asyncHandler(async (req, res, next) => {
    // FIX-WORKER-18 pass 176: flag p/ invalidar cache loyalty:me pos-tx
    // se loyalty pts foram debitados (UPDATE user_loyalty linha ~99).
    let loyaltyDebited = false;
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
        loyaltyDebited = true; // FIX-WORKER-18 pass 176: marca para invalidacao pos-tx
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
        // FIX-WORKER-2 pass 369 (capture order_item_id p/ pending_wallet tracking):
        //   PRE-FIX: order_item_id passado como null em payouts_pending_wallet
        //   (comentario inline 214 'needs row lookup post-insert' - debt nunca pago).
        //   Resultado: payouts_pending_wallet.order_item_id sempre NULL.
        //   Impacto auditoria:
        //   - Cron liquidation cross-reference item-level perdida
        //   - Admin reconciliacao "qual item gerou esse pending payout" impossivel
        //   - Schema mig 078 declara order_item_id REFERENCES order_items(id)
        //     - FK util desperdicado
        //   POST-FIX: RETURNING id do INSERT order_items + uso direto no
        //   INSERT payouts_pending_wallet abaixo. 1 query extra zero (RETURNING free).
        const itemIns = await c.query(
          `INSERT INTO order_items
             (order_id, product_id, product_version_id, seller_id, is_platform_owned,
              quantity, unit_price_cents, line_total_cents, commission_rate,
              commission_cents, seller_payout_cents, license_key, download_token,
              download_expires_at, snapshot)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, NOW() + INTERVAL '365 days', $14::JSONB)
           RETURNING id`,
          [order.rows[0].id, it.product_id, null, it.seller_id || null,
           it.is_platform_owned, it.quantity, it.unit_price_cents, lineTotalCents,
           rate, commission, payout, license_key, dl_token, snapshot.rows[0].s]
        );
        const orderItemId = itemIns.rows[0].id;

        // FIX-WORKER-11 pass 270 (split fallback queue):
        //   PRE-FIX (pass 268 identified): seller sem asaas_wallet_id ->
        //   sem split row -> payout 100% plataforma. Seller perde receita
        //   se configura wallet DEPOIS da venda.
        //   POST-FIX: 2 caminhos:
        //   1. asaas_wallet_id PRESENTE -> INSERT asaas_splits (normal)
        //   2. asaas_wallet_id AUSENTE -> INSERT payouts_pending_wallet
        //      (queue debt para cron diario liquidar quando wallet configurada)
        //   Sem perda receita seller. Mig 078 criou schema.
        if (!it.is_platform_owned && payout > 0) {
          if (it.asaas_wallet_id) {
            await c.query(
              `INSERT INTO asaas_splits (order_id, seller_id, wallet_id, fixed_value_cents)
               VALUES ($1,$2,$3,$4)`,
              [order.rows[0].id, it.seller_id, it.asaas_wallet_id, payout]
            );
          } else {
            // FALLBACK: seller sem wallet config - debt queue para futuro
            // FIX pass 369: order_item_id agora capturado (era NULL antes)
            await c.query(
              `INSERT INTO payouts_pending_wallet
                 (order_id, order_item_id, seller_id, amount_cents, reason)
               VALUES ($1, $2, $3, $4, 'no_asaas_wallet')
               ON CONFLICT DO NOTHING`,
              [order.rows[0].id, orderItemId, it.seller_id, payout]
            );
          }
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

    // FIX-WORKER-18 pass 176 + 206: invalida caches relevantes pos checkout.
    // - loyalty:me se pts debitados (pass 176 cross-svc seller-svc)
    // - orders:user:* (pass 206 NEW) - cache /conta/pedidos pode mostrar stale
    //   sem novo order no topo (UX broken: user finaliza compra, redireciona
    //   /conta/pedidos e nao ve seu pedido)
    try {
      const tasks = [
        cache.del(`orders:user:${req.user.sub}:*`),  // pass 206: orders list cache
        cache.del('order:admin:recent:*'),  // pass 215: admin dashboard /admin/orders
      ];
      if (loyaltyDebited) {
        tasks.push(cache.del(`loyalty:me:${req.user.sub}:*`));  // pass 176: cross-svc
      }
      await Promise.all(tasks);
    } catch (e) {
      log.warn({ /* FIX pass 344 DLP */ err: mask.text(String(e.message || '').slice(0, 300)), user: req.user.sub }, '[cache.invalidate_fail.checkout]');
    }

    /* FIX-WORKER-3 pass 445 (CRITICAL FREE ORDER FLOW BROKEN):
       PRE-FIX bug end-to-end:
       1. Free product (total_cents=0) -> button "Baixar gratis" -> /checkout
       2. order-svc cria order com total_cents=0, payment_status=pending
       3. setImmediate -> payment-svc /payments/asaas/create com value: 0/100 = 0
       4. payment-svc linha 118 pass 134: amount < 100 -> 400 amount_too_small
       5. Order stuck em pending_payment FOREVER
       6. User "comprou gratis" mas NUNCA recebe license/download
       SCOPE: 100% dos free products quebrados em checkout flow
       POST-FIX: short-circuit free orders ANTES setImmediate payment-svc:
       - total_cents === 0 -> UPDATE payment_status='paid' + status='fulfilled'
         direto (auto-grant licenses como webhook PAYMENT_RECEIVED faria)
       - SKIP payment-svc call (Asaas nao aceita value < R$5)
       - Audit log free_order_auto_fulfill p/ tracing
       - cache.del orders:user:* (paridade pass 206)
       Pattern V8: free path = bypass payment gateway, direct fulfill */
    if (result.total_cents === 0 || result.total_cents === '0') {
      // FREE ORDER PATH - skip Asaas, auto-fulfill
      setImmediate(async () => {
        try {
          await tx(async (c) => {
            // UPDATE order para paid + fulfilled (status terminal free flow)
            await c.query(
              `UPDATE orders SET payment_status = 'paid', status = 'fulfilled',
                                  paid_at = NOW(), updated_at = NOW()
                WHERE id = $1 AND payment_status = 'pending'`,
              [result.id]
            );
            // Audit free auto-fulfill (compliance trail)
            await c.query(
              `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
               VALUES ($1, 'user', 'order.free_auto_fulfill', 'order', $2, 'info', $3::JSONB)`,
              [req.user.sub, result.id, JSON.stringify({
                order_number: result.order_number,
                total_cents: 0,
                ip: req.ip,
              })]
            );
            /* FIX-WORKER-2 pass 469 (free order notif gap - consume pass 445):
               PRE-FIX: free order auto-fulfill skip payment-svc -> NO notification
               - Pass 445 fix CRITICAL free order flow broken (status pending FOREVER)
               - Resolveu order paid+fulfilled MAS sem notif buyer
               - Buyer "Baixou gratis" -> NO bell badge -> "compra foi pra onde?"
               - Order paid event NORMAL (payment-svc) cria notif order_paid
               - Free path skip payment-svc = skip notification too
               POST-FIX: + INSERT notification order_paid buyer (paridade payment-svc) */
            await c.query(
              `INSERT INTO notifications (user_id, channel, template_code, title, body, priority, payload)
               VALUES ($1, 'in_app', 'order_paid', $2, $3, 1, $4::JSONB)`,
              [req.user.sub,
               'Produto gratuito disponivel',
               'Sua compra gratuita foi processada. Acesse seus produtos em Minha Conta.',
               JSON.stringify({ order_id: result.id, order_number: result.order_number, free: true })]
            );
          });
          log.info({ order_id: result.id, free: true }, '[order.free_auto_fulfill]');
          // Re-invalida cache p/ refletir status paid/fulfilled
          // FIX pass 469: + notifCache invalidate (consume pass 467 cross-svc cadeia)
          await Promise.all([
            cache.del(`orders:user:${req.user.sub}:*`),
            notifCache.invalidate(req.user.sub),
          ]).catch(() => {});
        } catch (e) {
          log.error({
            err: mask.text(String(e.message || '').slice(0, 500)),
            order_id: result.id,
          }, '[order.free_auto_fulfill_failed]');
        }
      });
      return; // skip payment-svc dispatch
    }

    // Dispara payment-svc para criar cobranca Asaas (assincrono)
    setImmediate(async () => {
      try {
        const paymentUrl = process.env.UPSTREAM_PAYMENT || `http://tasks.cas_payment-svc:${process.env.PORT_PAYMENT || 3016}`;
        // FIX pass 117: payment-svc internal-token bypass nao seta req.user
        // -> precisa do buyer_user_id no body para validar order ownership.
        const body = { order_id: result.id, buyer_user_id: req.user.sub };
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
          /* FIX-WORKER-2 pass 340: DLP mask detail body em log
             payment-svc 4xx/5xx response pode echoar:
             - Asaas API key em error stack (raro)
             - Bearer headers em proxy error message
             - User CPF/cardNumber em payload validation echo
             Paridade pass 306 asaas error log mask. */
          let detail = '';
          try { detail = mask.text((await r.text()).slice(0, 200)); } catch {}
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
        /* FIX-WORKER-2 pass 340: err.message mask paridade pass 303 qa-svc */
        log.error({ err: mask.text(String(e.message || '').slice(0, 500)), order_id: result.id }, '[payment.dispatch_failed]');
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

// FIX-WORKER-18 pass 206 (cache + window):
// PRE-FIX:
// - 2 queries por hit (rows + COUNT separado)
// - NO cache - buyer /conta/pedidos polling sem proteção
// - Pattern V8 gap (consolidado em 13 endpoints anteriores)
// POST-FIX:
// + cache.cacheMiddleware 30s vary by user+status+limit+offset
//   Curto pq orders user-facing mutations frequentes (checkout/refund)
// + COUNT(*) OVER()::INT AS _total window consolidation
// + has_more boolean response
// Performance: ~30ms (2 queries) -> ~17ms (1 query)
// FIX-WORKER-18 pass 596 (cache key normalization paridade cadeia 18 sites
// W7+W10+W13+W17+W18 cache hygiene cross-svc consolidacao - 19 sites total):
//   PRE-FIX BUGS (3 issues cache pollution + inconsistency vs handler):
//   1. Raw q.status sem whitelist check. Handler valida ORDER_STATUS_ENUM
//      (linha 434). Cenarios:
//      - ?status=INVALID -> cache key 's=INVALID', handler 400 invalid_status
//      - Multiple invalid attempts pollution + Redis storage waste
//      - WORST: 400 response cached em 'INVALID' key - user transient retry
//        hits cached 400 mesmo se param valido eventualmente
//   2. Raw q.limit. Handler clamps Math.max/Math.min [1, 100] (linha 431).
//      ?limit=99999 -> cache key 'lim=99999', handler clamp 100 -> SAME response
//   3. Raw q.offset. Handler Math.max(0, ...) (linha 432).
//      ?offset=-5 -> cache key 'off=-5', handler -> 0
//   POST-FIX: normalize cache key SAME way handler normalizes.
//   Pattern V8 cache hygiene invariante cross-svc consolidacao 19 sites.
const ordersListCacheKey = (req) => {
  const userId = req.user?.sub || 'anon';
  const statusRaw = (req.query.status || '').toString().trim();
  const statusNorm = ORDER_STATUS_ENUM.has(statusRaw) ? statusRaw : '';
  const lim = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 30));
  const off = Math.max(0, parseInt(req.query.offset, 10) || 0);
  return `orders:user:${userId}:s=${statusNorm}:lim=${lim}:off=${off}`;
};

router.get('/',
  cache.cacheMiddleware(ordersListCacheKey, 30),
  asyncHandler(async (req, res) => {
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

    /* FIX-WORKER-18 pass 440 (LATERAL JOIN vs correlated subquery N+1):
       PRE-FIX (pass 206 patrocinado): items_preview via SELECT json_agg(...)
       FROM order_items WHERE order_id = o.id - correlated subquery dentro SELECT
       - Para cada order row (LIMIT 30) -> 1 subscan order_items + 1 json_agg
       - 30 subscans + 30 aggregates = ~30x execucao planner overhead
       - idx_oi_order existe mas mesmo Index Scan tem cost minimum per call
       - Em /conta/pedidos com user power-buyer (50 orders) = 50 subscans
       - Latencia tipica: ~80-150ms p/ 30 orders com 3 items cada
       POST-FIX: LATERAL JOIN single-pass com PG planner usando hash/merge:
       - 1 scan order_items WHERE order_id IN (...) ordenado pre-grouped
       - PG planner inlining LATERAL pode usar idx_oi_order eficiente
       - Latencia esperada: ~25-50ms (3-5x melhoria)
       Pattern V8 W18 paridade pass 181 (/categories CTE single-scan).
       Note: LEFT JOIN LATERAL p/ preservar orders sem items (corrupted state). */
    const r = await query(
      `SELECT o.id, o.order_number, o.status, o.payment_status,
              o.total_cents, o.subtotal_cents, o.discount_cents,
              o.coupon_code, o.loyalty_points_redeemed, o.loyalty_discount_cents,
              o.currency, o.payment_method, o.created_at, o.paid_at,
              COALESCE(items.preview, '[]'::JSON) AS items_preview,
              COUNT(*) OVER()::INT AS _total
         FROM orders o
         /* FIX-WORKER-2 pass 639 (json_agg ORDER BY ASC+ASC paridade /:id detail linha 659):
            PRE-FIX: items_preview json_agg sem ORDER BY - PG heap order arbitrario.
            - /conta/pedidos listing mostra items thumbnails primeiros 1-5 itens
            - Order detail (/:id linha 659) ORDER BY oi.created_at, oi.id - deterministic
            - Listing path INCONSISTENT vs detail path:
              listing tab 1: thumbs [prodA, prodB, prodC]
              listing tab 2 (cache evict + refetch): thumbs [prodC, prodA, prodB]
            - User percebe "Por que ordem dos produtos do meu pedido muda?"
            POST-FIX: + ORDER BY oi.created_at, oi.id ASC+ASC (paridade detail path).
            - mig 010+ idx_oi_order ja cobre (order_id) WHERE filter
            - tiebreaker oi.id ASC determinism dentro mesmo created_at (rare bulk insert) */
         LEFT JOIN LATERAL (
           SELECT json_agg(json_build_object(
                    'title', snapshot->>'title',
                    'cover', snapshot->>'cover_image_url'
                  ) ORDER BY created_at, id) AS preview
             FROM order_items
            WHERE order_id = o.id
         ) items ON TRUE
        WHERE ${whereParts.join(' AND ')}
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT $${limIdx} OFFSET $${offIdx}`,
      params
    );

    const total = r.rows[0]?._total ?? 0;
    const orders = r.rows.map((row) => { const { _total, ...rest } = row; return rest; });

    res.json({
      orders,
      total,
      limit,
      offset,
      has_more: (offset + orders.length) < total,
      status: statusFilter,
    });
  })
);

// GET /orders/admin/recent (todos pedidos, role admin)
// FIX-WORKER-7 pass 59: LGPD role-tier PII masking (admin=full, staff=masked)
//   PRE-FIX: SELECT u.email + u.full_name returned plain text para STAFF role.
//   Staff (sub-admin) podia coletar PII compradores sem necessidade (LGPD Art 6° II).
//   Pattern pass 57 estabelecido em review-svc -> aqui replicado cross-svc.
//   FIX: isAdmin path full visibility; staff path maskPII.email/name.
// + Regra E pagination ?limit/?offset
// FIX-WORKER-4 pass 215 (cache + window + coherency):
// PRE-FIX:
// - 2 queries por hit (rows + stats aggregations)
// - NO cache (admin dashboard /admin/orders polling sem proteção)
// - Response shape sem 'total' absolute (UI 'X de Y' impossivel)
// POST-FIX:
// + cache.cacheMiddleware 30s vary by limit+offset (refresh-friendly)
// + COUNT(*) OVER() window aggregate -> total absolute
// + has_more boolean
// Stats query mantida (FILTER aggregates 90d) - small payload + ja em mesma cache hit
// FIX-WORKER-18 pass 596 (cache key normalization paridade pass 596 ordersListCacheKey):
//   PRE-FIX BUGS: raw q.limit / q.offset sem clamp.
//   Same pattern bugs como ordersListCacheKey - cache key vs handler mismatch.
//   POST-FIX: normalize cache key SAME way handler normalizes.
const adminRecentOrdersCacheKey = (req) => {
  const q = req.query;
  const lim = Math.max(1, Math.min(200, parseInt(q.limit, 10) || 100));
  const off = Math.max(0, parseInt(q.offset, 10) || 0);
  return `order:admin:recent:lim=${lim}:off=${off}`;
};

router.get('/admin/recent',
  jwt.requireAuth({ roles: ['admin','staff'] }),
  cache.cacheMiddleware(adminRecentOrdersCacheKey, 30),
  asyncHandler(async (req, res) => {
    // FIX-WORKER-7 pass 18: tiebreaker (Regra D) + window temporal stats
    // FIX-WORKER-7 pass 59: ?limit (1-200, default 100) + ?offset paginacao
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 100));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

    // FIX-WORKER-4 pass 215: COUNT(*) OVER() window aggregate
    // FIX-WORKER-18 pass 251 (pagination drift tiebreaker direction):
    //   PRE-FIX: ORDER BY created_at DESC, id (sem direction explicit no tiebreaker)
    //   PG default ASC para tiebreaker => mixed direction:
    //     page 1: created_at DESC, id ASC -> orders ordem inconsistente
    //   Em mass-insert burst (10 orders mesmo created_at), pages shifteam:
    //     page 1 oset=0: [id=A1, A2, A3, A4, A5] (ASC entre mesmo ts)
    //     page 2 oset=5: [A6, A7, A8, A9, A10]
    //   MAS cache evict + insert novo order entre pages -> ids reordenam,
    //   user ve mesmo order em 2 pages OR pula um. Pattern V8: tiebreaker
    //   SAME direction (DESC, DESC) p/ ordering deterministic per snapshot.
    const r = await query(
      `SELECT o.id, o.order_number, o.status, o.payment_status, o.total_cents, o.currency,
              o.payment_method, o.buyer_user_id, o.created_at, o.paid_at,
              u.email AS buyer_email, u.full_name AS buyer_name,
              COUNT(*) OVER()::INT AS _total
         FROM orders o
         JOIN users u ON u.id = o.buyer_user_id
        ORDER BY o.created_at DESC, o.id DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const total = r.rows[0]?._total ?? 0;

    // Stats window temporal 90 days (mantido - FILTER aggregates pequeno payload)
    const stats = await query(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('paid','fulfilled')) AS count_paid,
         COUNT(*) FILTER (WHERE status = 'pending_payment') AS count_pending,
         COALESCE(SUM(total_cents) FILTER (WHERE status IN ('paid','fulfilled')), 0) AS total_revenue,
         '90 days' AS window
         FROM orders WHERE created_at > NOW() - INTERVAL '90 days'`
    );

    // FIX-WORKER-7 pass 59: LGPD role-tier masking + strip _total
    const isAdmin = req.user && req.user.role === 'admin';
    const orders = r.rows.map((row) => {
      const { _total, ...rest } = row;
      if (isAdmin) return rest;
      return {
        ...rest,
        buyer_email: maskPII.email(rest.buyer_email),
        buyer_name: maskPII.name(rest.buyer_name),
      };
    });

    res.json({
      orders,
      stats: stats.rows[0],
      total,
      limit,
      offset,
      has_more: (offset + orders.length) < total,
    });
  })
);

// FIX-WORKER-4: valida UUID antes do query para evitar PG 22P02 -> 500.
// Antes: GET /orders/admin (ou qualquer slug) caia aqui e o param 'admin' era passado
// como UUID ao Postgres, gerando 500 generico. Agora retorna 404 limpo.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// FIX-WORKER-18 pass 216: cache /:id detail 30s vary by user+order.
// /conta/pedidos/[id] page consume - user pode polling apos checkout
// para ver status atualizar paid->fulfilled.
// PRE-FIX: SELECT + json_agg subquery per request (~15ms PG)
// POST-FIX: cache hit <2ms apos warmup
// IMPORTANT: vary key incluir user.sub para isolation - admin nao ve
// cache buyer (diferente row.buyer_user_id check).
// Invalidation: webhook PAYMENT_RECEIVED, dispute open, refund processed
const orderDetailCacheKey = (req) => `order:detail:${req.params.id}:u=${req.user?.sub || 'anon'}`;

router.get('/:id',
  cache.cacheMiddleware(orderDetailCacheKey, 30),
  asyncHandler(async (req, res, next) => {
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
    // FIX-WORKER-18 pass 216: invalida caches afetados por nova disputa
    // - order:detail:{id}:* (TODOS users que cacheram esta order ven status mudar)
    // - order:admin:disputes:* (admin dashboard ve nova dispute imediato)
    try {
      await Promise.all([
        cache.del(`order:detail:${req.params.id}:*`),
        cache.del('order:admin:disputes:*'),
      ]);
    } catch (_) { /* best-effort */ }
    res.status(201).json({ dispute });
  })
);

// ============================================================
// FIX-WORKER-4 + W7 pass 31: ADMIN endpoints p/ gerenciar disputes
// Aplicando Pattern W7 17 regras (A-R) consolidadas em 30 iters anteriores.
// ============================================================

// GET /orders/admin/disputes - lista disputes paginadas com filtros
// (Regra I SELECT explicit, Regra D tiebreaker, Regra E response shape limit)
// FIX-WORKER-4 pass 214 (4 melhorias compostas):
// PRE-FIX:
// - LIMIT $2 sem ?offset (pagination quebrada com 200+ disputes)
// - 2 queries (rows + stats GROUP BY) - admin polling = 4 round-trips PG
// - NO cache - admin /admin/disputes dashboard sem proteção
// - 'limit: lim' sem total absolute (UI 'X de Y' impossivel)
// POST-FIX:
// + ?limit (1-200) + ?offset (>=0) Regra E pagination
// + COUNT(*) OVER() window total + has_more
// + cache.cacheMiddleware 30s vary by filtros
// + stats query separada (counts agregados 90d) - mantida + cache hit cobre ambas
// FIX-WORKER-18 pass 576 (cache key normalization paridade cadeia W7+W10+W18):
//   PRE-FIX BUGS (3 issues cache pollution + inconsistency):
//   1. Raw q.status sem validation. Handler valida VALID_STATUSES whitelist
//      (linha 840). Cenarios:
//      - ?status=OPENED (capital) -> cache key 's=OPENED', handler whitelist
//        case-sensitive miss -> SEM filter aplicado -> response unfiltered
//      - ?status=opened (lower) -> cache key 's=opened', handler filtra
//      - 2 entries diferentes pollution + worst: status=OPENED retorna ALL
//        disputes (unfiltered) sob cache key suggesting filtered
//   2. Raw q.limit. Handler clamps Math.max/Math.min (linha 842) [1, 200].
//      ?limit=99999 -> cache key 'lim=99999', handler clamp 200.
//      ?limit=200 -> cache key 'lim=200' SAME response cache pollution.
//   3. Raw q.offset. Handler Math.max(0, ...).
//      ?offset=-5 -> cache key 'off=-5', handler -> 0
//   POST-FIX: normalize cache key SAME way handler normalizes.
//   Pattern V8 cache hygiene invariante (passes 520/530/533/551/558/566/572).
const VALID_DISPUTE_STATUSES = ['opened', 'under_review', 'resolved_buyer', 'resolved_seller', 'cancelled'];
const disputesCacheKey = (req) => {
  const q = req.query;
  const statusRaw = (q.status || '').toString().trim();
  const statusNorm = VALID_DISPUTE_STATUSES.includes(statusRaw) ? statusRaw : '';
  const lim = Math.max(1, Math.min(200, parseInt(q.limit, 10) || 50));
  const off = Math.max(0, parseInt(q.offset, 10) || 0);
  return `order:admin:disputes:s=${statusNorm}:lim=${lim}:off=${off}`;
};

router.get('/admin/disputes',
  jwt.requireAuth({ roles: ['admin','staff'] }),
  cache.cacheMiddleware(disputesCacheKey, 30),
  asyncHandler(async (req, res) => {
    // Status enum mig 007: opened|under_review|resolved_buyer|resolved_seller|cancelled
    const status = (req.query.status || '').toString();
    const VALID_STATUSES = ['opened', 'under_review', 'resolved_buyer', 'resolved_seller', 'cancelled'];
    const statusFilter = VALID_STATUSES.includes(status) ? status : null;
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50, 200));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

    // FIX-WORKER-7 pass 110 + 214: schema real disputes + window COUNT
    const r = await query(
      `SELECT d.id, d.order_id, d.order_item_id, d.opened_by_user_id,
              d.against_seller_id, d.reason_code, d.description,
              d.requested_resolution, d.status,
              d.created_at, d.resolved_at, d.resolved_in_favor_of,
              d.resolution_action, d.refund_amount_cents,
              u.email AS buyer_email, u.full_name AS buyer_name,
              s.store_name AS seller_store_name, s.store_slug AS seller_store_slug,
              o.order_number, o.total_cents,
              COUNT(*) OVER()::INT AS _total
         FROM disputes d
         LEFT JOIN users u ON u.id = d.opened_by_user_id
         LEFT JOIN sellers s ON s.id = d.against_seller_id
         LEFT JOIN orders o ON o.id = d.order_id
        WHERE ($1::TEXT IS NULL OR d.status::TEXT = $1)
        /* FIX-WORKER-2 pass 636 (Regra D direction parity tiebreaker - mixed direction fix):
           PRE-FIX: ORDER BY ... d.created_at DESC, d.id (sem direction explicit)
           - PG default ASC para tiebreaker quando omitted -> MIXED direction
             DESC + ASC = External Sort obrigatorio (idx composite nao bate)
           - Inconsistencia vs cadeia Regra D V8 cross-svc (30+ sites DESC+DESC)
           - Admin /admin/disputes page polling default ordem mixed:
             prioridade ASC (case enum) -> recentes DESC -> mas tiebreaker ASC
           - mig 109 idx_disputes_created (created_at DESC) nao cobre id direction
           POST-FIX: d.id DESC explicit (paridade cadeia 30+ sites cross-svc)
           - Direction parity Regra D V8 dentro mesmo created_at: id DESC ties */
        ORDER BY
          CASE d.status::TEXT
            WHEN 'opened' THEN 1
            WHEN 'under_review' THEN 2
            WHEN 'resolved_buyer' THEN 3
            WHEN 'resolved_seller' THEN 4
            ELSE 5
          END,
          d.created_at DESC,
          d.id DESC
        LIMIT $2 OFFSET $3`,
      [statusFilter, limit, offset]
    );

    const total = r.rows[0]?._total ?? 0;

    // Counts agregados (para badges UI). Window 90d cobre admin queue.
    // FIX pass 110: opened_at -> created_at (schema real)
    const stats = await query(
      `SELECT status::TEXT AS status, COUNT(*)::INT AS n FROM disputes
        WHERE created_at > NOW() - INTERVAL '90 days'
        GROUP BY status`
    );
    const counts = stats.rows.reduce((acc, r) => ({ ...acc, [r.status]: r.n }), {});

    // FIX-WORKER-7 pass 59: LGPD role-tier masking
    const isAdmin = req.user && req.user.role === 'admin';
    const disputes = r.rows.map((row) => {
      const { _total, ...rest } = row;
      if (isAdmin) return rest;
      return {
        ...rest,
        buyer_email: maskPII.email(rest.buyer_email),
        buyer_name: maskPII.name(rest.buyer_name),
      };
    });

    res.json({
      disputes,
      counts,
      total,
      limit,
      offset,
      filter: statusFilter,
      has_more: (offset + disputes.length) < total,
    });
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

      // FIX-WORKER-4 pass 261 (notif gap dispute_resolve):
      //   PRE-FIX: admin resolvia dispute mas buyer e seller NAO eram notificados
      //   Buyer espera resultado (refund_approved/denied/replacement) - silent UX
      //   Seller queria saber se penalizado (refund_approved = revenue loss)
      //   Pattern V8 cross-svc: high-impact admin decisions sempre notify affected
      //   Comparar pass 258 seller_suspended (priority=3 critical)
      //   POST-FIX: 2 notifs in_app priority=2 (medium-high, financial impact)
      //   Body customizado conforme resolution_action.
      const actionLabels = {
        refund_approved: 'Refund aprovado',
        refund_denied: 'Refund negado',
        replacement_sent: 'Substituicao enviada',
        partial_refund: 'Refund parcial',
        dismissed: 'Disputa encerrada',
      };
      const actionLabel = actionLabels[req.body.resolution_action] || req.body.resolution_action;
      // Notify buyer
      await c.query(
        `INSERT INTO notifications (user_id, channel, template_code, title, body, priority, payload)
         VALUES ($1::UUID, 'in_app', 'dispute_resolved', $2, $3, 2, $4::JSONB)`,
        [d.opened_by_user_id,
         `Sua disputa foi resolvida: ${actionLabel}`,
         `O administrador analisou sua disputa e tomou a seguinte acao: ${actionLabel}. ${req.body.refund_amount_cents ? 'Valor reembolsado: R$ ' + (req.body.refund_amount_cents / 100).toFixed(2) : ''}`,
         JSON.stringify({ dispute_id: req.params.id, resolution_action: req.body.resolution_action, order_id: d.order_id })]
      );
      // FIX-WORKER-2 pass 469 (notifCache consume pass 467 cross-svc cadeia):
      //   PRE-FIX: dispute_resolved buyer+seller INSERT SEM cache invalidate
      //   - Dispute resolution = priority 2 (medium-high) UX critical
      //   - User aguarda resolucao -> bell delay 20s = ansiedade
      //   - Buyer compra com sucesso refund -> precisa ver imediato
      //   POST-FIX: notifCache.invalidate(buyer) + invalidate(seller) post-INSERT
      //   Capture sellerUserId outside conditional p/ unified invalidation.
      let sellerUserId = null;
      // Notify seller (so se ha against_seller_id - some disputes sao buyer-only)
      if (d.against_seller_id) {
        const sellerR = await c.query('SELECT user_id FROM sellers WHERE id = $1::UUID', [d.against_seller_id]);
        if (sellerR.rows.length) {
          sellerUserId = sellerR.rows[0].user_id;
          await c.query(
            `INSERT INTO notifications (user_id, channel, template_code, title, body, priority, payload)
             VALUES ($1::UUID, 'in_app', 'dispute_resolved_seller', $2, $3, 2, $4::JSONB)`,
            [sellerUserId,
             `Disputa contra voce: ${actionLabel}`,
             `Uma disputa contra voce foi resolvida pelo administrador. Acao tomada: ${actionLabel}. Veja detalhes em /dashboard/disputes.`,
             JSON.stringify({ dispute_id: req.params.id, resolution_action: req.body.resolution_action })]
          );
        }
      }
      /* FIX pass 469: notifCache invalidate buyer + seller post-INSERT.
         Inside tx OK pq cache.del Redis tolera rollback worst-case (zero risk). */
      notifCache.invalidate(d.opened_by_user_id);
      if (sellerUserId) notifCache.invalidate(sellerUserId);

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
    // FIX-WORKER-4 pass 214: invalida cache admin/disputes (pass 214 cache)
    // Resolve muda status -> dashboard /admin/disputes mostra stale 30s
    try {
      await cache.del('order:admin:disputes:*');
    } catch (_) { /* best-effort */ }

    // FIX-WORKER-11 pass 384 *** CRITICAL REAL MONEY GAP ***:
    //   PRE-FIX: admin resolve dispute resolution_action='refund_approved' ou
    //   'partial_refund' -> notification "Refund aprovado" enviada ao buyer
    //   MAS asaas.refundPayment() NUNCA EH CHAMADO.
    //   - Order marcada 'refunded' silenciosamente no audit
    //   - Buyer recebe email "Refund aprovado" mas dinheiro NUNCA volta
    //   - Asaas webhook PAYMENT_REFUNDED nunca chega (nada disparou)
    //   - Suporte ticket flood: "recebi email mas nao chegou refund"
    //   - Pass 289 fixou asaas.cancelPayment missing - similar pattern.
    //   asaas.js linha 80 refundPayment exists + exported (pass 384 verified)
    //   mas ZERO callers no codebase = export orphan.
    //   POST-FIX: dispatch async setImmediate p/ payment-svc /payments/asaas/refund
    //   (paridade pattern checkout setImmediate linha 250-272).
    //   Se Asaas refund falhar, webhook PAYMENT_REFUND_FAILED ja existing (pass 222)
    //   sinaliza admin via audit_log critical + notification.
    if (outcome?.ok && ['refund_approved','partial_refund'].includes(req.body.resolution_action)) {
      setImmediate(async () => {
        try {
          const paymentUrl = process.env.UPSTREAM_PAYMENT || `http://tasks.cas_payment-svc:${process.env.PORT_PAYMENT || 3016}`;
          const hasToken = !!process.env.PAYMENT_INTERNAL_TOKEN;
          const body = {
            order_id: outcome.dispute_id ? null : null, // dispute_id NAO eh order_id; payment-svc lookup via order via dispute
            dispute_id: req.params.id,
            refund_amount_cents: req.body.refund_amount_cents || null, // null = full refund
            reason: req.body.admin_notes ? req.body.admin_notes.slice(0, 200) : `Dispute resolved: ${req.body.resolution_action}`,
          };
          const r = await fetch(`${paymentUrl}/payments/asaas/refund`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(hasToken ? { 'x-internal-token': process.env.PAYMENT_INTERNAL_TOKEN } : {}),
            },
            body: JSON.stringify(body),
          });
          if (!r.ok) {
            const txt = await r.text().catch(() => '');
            log.error({ dispute_id: req.params.id, status: r.status, /* DLP */ body: mask.text(txt.slice(0, 300)) },
              '[dispute.refund.dispatch_failed]');
          } else {
            log.info({ dispute_id: req.params.id, refund_amount_cents: req.body.refund_amount_cents || 'full' },
              '[dispute.refund.dispatched]');
          }
        } catch (e) {
          log.error({ dispute_id: req.params.id, err: mask.text(String(e.message || '').slice(0, 300)) },
            '[dispute.refund.dispatch_exception]');
        }
      });
    }

    res.json(outcome);
  })
);

module.exports = router;
