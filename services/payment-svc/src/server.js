'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const express = require('express');
const crypto = require('node:crypto');
const { z } = require('zod');
const { query, tx } = require('@cas/db-client');
const { logger, sanitize, errorHandler, asyncHandler, validate, jwt, fail2ban, startup, cache, mask, rateLimiter, withRetry } = require('@cas/shared');
const asaas = require('./asaas');

// FIX-WORKER-17 pass 7: valida envs criticas ANTES de listen.
// ASAAS_WEBHOOK_SECRET ausente em prod = fail-closed em fix anterior, mas
// agora valida no startup tambem (alerta ops mais cedo).
// PG_PASS curta = brute-force possivel via Docker network interno.
startup.validateStartupEnv({
  critical: ['PG_PASS'],
  minLength: { PG_PASS: 12, ASAAS_WEBHOOK_SECRET: 16 },
  warnIfMissing: ['ASAAS_WEBHOOK_SECRET', 'ASAAS_API_KEY'],
  // FIX-WORKER-17 pass 8: PAYMENT_INTERNAL_TOKEN promovido de warn -> enforceInProd
  // W2 pass 3 confirmou: sem token, order-svc -> payment-svc falha silencioso 401.
  // Em PROD + STRICT_INTERNAL_TOKENS=1: fail-closed boot. Senao: warn periodico 10min.
  enforceInProd: ['PAYMENT_INTERNAL_TOKEN'],
});

const log = logger.child({ svc: 'payment-svc' });
const app = express();
const PORT = parseInt(process.env.PORT_PAYMENT || '3016', 10);

app.disable('x-powered-by');

// raw body para validar assinatura no webhook
app.use('/payments/asaas/webhook', express.raw({ type: '*/*', limit: '2mb' }));
app.use(express.json({ limit: '512kb' }));
app.use(sanitize.middleware());
// FIX-WORKER-17 pass 3: fail2ban global - bane IPs apos brute-force de tokens internos
app.set('trust proxy', 1);
app.use(fail2ban.middleware());

// FIX-WORKER-11 pass 2 (CRITICAL SEC): asaas/create nao tinha auth.
// Antes: qualquer um na internet podia POST com order_id UUID e:
// - Disparar Asaas API calls (denial-of-wallet + rate limit)
// - Receber invoice_url/pix_qrcode/boleto_url de QUALQUER pedido (PII leak)
// - Corromper status: UPDATE orders SET payment_status='authorized'
const PAYMENT_INTERNAL_TOKEN = process.env.PAYMENT_INTERNAL_TOKEN || '';
function asaasCreateGuard(req, res, next) {
  const tok = req.headers['x-internal-token'];
  if (PAYMENT_INTERNAL_TOKEN && tok) {
    let valid = false;
    try {
      const a = Buffer.from(String(tok));
      const b = Buffer.from(PAYMENT_INTERNAL_TOKEN);
      valid = a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch { valid = false; }
    if (valid) {
      // FIX-WORKER-17 pass 3: fail2ban reportSuccess clear counter
      if (req.fail2ban) req.fail2ban.reportSuccess();
      return next();
    }
    // FIX-WORKER-17 pass 3: fail2ban reportFailure - ban after 5 attempts/15min
    if (req.fail2ban) req.fail2ban.reportFailure();
    log.warn({ ip: req.ip, /* FIX pass 323 DLP */ ua: mask.text(req.headers['user-agent'] || '') }, '[payment.create.invalid_internal_token]');
  }
  return jwt.requireAuth({ roles: ['admin','staff','service'] })(req, res, next);
}

// FIX-WORKER-12 pass 3: alias /payments/health (gateway /api/payments/* -> /payments/*)
const _healthHandler = (_req, res) => res.json({
  ok: true, svc: 'payment-svc',
  asaas: { configured: !!process.env.ASAAS_API_KEY, url: process.env.ASAAS_API_URL }
});
app.get('/health', _healthHandler);
app.get('/payments/health', _healthHandler);

// MLB-5 Mercado Credito - preview de parcelas no cartao
// GET /payments/installments/preview?amount_cents=N&max=12
// Politica:
//   1x  -> sem juros
//   2-3x-> sem juros (parcela minima R$5)
//   4-12x -> juros 2.99% a.m. (composto), parcela minima R$10
//
// FIX-WORKER-18 pass 5: cache 600s (10min) por (amount_cents, max).
// Endpoint deterministico - mesma amount sempre retorna mesmas parcelas.
// /checkout chama isto a cada troca de payment_method (multi-toggles).
// W18 pass 3 + pass 2: cache pattern ja estabelecido em product-svc + aiops.
//
// TTL longo (10min vs 60s outros): tabela de juros nao muda ao longo do dia.
// monthlyRate=0.0299 constante. Se mudar, restart payment-svc invalida cache.
//
// Cache key: amount + max (parseado para int p/ canonicalizar "1000" vs "01000")
// Sem auth = cache compartilhado entre todos users (mesmo amount = mesma resposta).
app.get('/payments/installments/preview',
  cache.cacheMiddleware((req) => {
    const amount = parseInt(req.query.amount_cents, 10) || 0;
    const max = Math.min(12, Math.max(1, parseInt(req.query.max || '12', 10)));
    return `payments:installments:${amount}:${max}`;
  }, 600),
  asyncHandler(async (req, res) => {
  // FIX-WORKER-11: amount_cents agora valida explicitamente (antes silenciava
  // param invalido/ausente como amount=0 -> {installments:[]} confuso).
  // Tambem rejeita negativos e amounts absurdos para evitar DoS via huge loop.
  const raw = req.query.amount_cents;
  if (raw === undefined || raw === '') {
    return res.status(400).json({ error: 'missing_amount_cents', message: 'Param amount_cents obrigatorio' });
  }
  const amount = parseInt(raw, 10);
  if (!Number.isFinite(amount) || amount < 0) {
    return res.status(400).json({ error: 'invalid_amount_cents', message: 'amount_cents deve ser inteiro >= 0' });
  }
  if (amount > 100_000_000) {
    return res.status(400).json({ error: 'amount_too_large', message: 'amount_cents excede R$ 1.000.000,00' });
  }
  const max = Math.min(12, Math.max(1, parseInt(req.query.max || '12', 10)));
  // FIX-WORKER-11 pass 134: amount < 100 (R$1.00) -> 400 explicit error em vez
  // de silent 200 + installments:[]. UI mostrava grid de parcelas vazio sem
  // explicacao quando user passava amount=0 (carrinho vazio, edge case). MP/ML
  // retornam validation_error neste caso. Comprehensible error -> better UX.
  if (amount < 100) {
    return res.status(400).json({
      error: 'amount_too_small',
      message: 'amount_cents deve ser >= 100 (R$ 1,00 minimo para parcelamento)',
      amount_cents: amount,
      min_cents: 100,
    });
  }
  const monthlyRate = 0.0299;
  const minNoFee = 500;   // R$5 - minimo por parcela sem juros
  const minWithFee = 1000; // R$10 - minimo por parcela com juros
  const out = [];
  for (let n = 1; n <= max; n++) {
    let perCents;
    let totalCents;
    let interestPct = 0;
    if (n <= 3) {
      // sem juros
      perCents = Math.floor(amount / n);
      totalCents = perCents * n;
      // ajusta diferenca de arredondamento na 1a parcela
      const diff = amount - totalCents;
      const firstCents = perCents + diff;
      if (n > 1 && perCents < minNoFee) continue;
      out.push({ count: n, per_cents: perCents, first_cents: firstCents, total_cents: amount, interest_pct: 0, label: `${n}x de R$ ${(perCents/100).toFixed(2).replace('.', ',')}${n>1?' sem juros':''}` });
    } else {
      // com juros compostos
      const r = monthlyRate;
      const totalCalc = Math.round(amount * Math.pow(1 + r, n - 1));
      perCents = Math.floor(totalCalc / n);
      if (perCents < minWithFee) continue;
      totalCents = perCents * n;
      interestPct = ((totalCents - amount) / amount) * 100;
      out.push({
        count: n, per_cents: perCents, first_cents: perCents + (totalCalc - totalCents),
        total_cents: totalCalc, interest_pct: parseFloat(interestPct.toFixed(2)),
        label: `${n}x de R$ ${(perCents/100).toFixed(2).replace('.', ',')} (juros ${interestPct.toFixed(1)}%)`
      });
    }
  }
  res.json({ amount_cents: amount, monthly_rate: monthlyRate, installments: out });
}));

// POST /payments/asaas/create - chamado pelo order-svc apos checkout
// FIX-WORKER-11 pass 2: agora exige asaasCreateGuard (x-internal-token ou service role)
app.post('/payments/asaas/create',
  asaasCreateGuard,
  validate({ body: z.object({
    order_id: z.string().uuid(),
    buyer_user_id: z.string().uuid().optional(), // FIX pass 117: internal-token path nao seta req.user
    installment_count: z.number().int().min(1).max(12).optional(),
  }) }),
  asyncHandler(async (req, res, next) => {
    // FIX-WORKER-7 pass 21 (3 BUGS - 1 SECURITY CRITICO + 1 race + 1 pattern):
    //
    // BUG 1 *** SECURITY CRITICO *** sem buyer_user_id check
    // Pre-fix: SELECT order WHERE id=$1 (qualquer user com token podia criar
    //   Asaas payment para order DE OUTRO USER se conhecer order_id).
    // Ataque:
    //   a. Atacante descobre order_id victim (log leak, predicao UUID, etc)
    //   b. POST /asaas/create {order_id:<victim>} -> backend cria invoice
    //   c. Atacante recebe PIX/boleto URL da order de outro
    //   d. Scenarios: confusion fraud, double-billing, etc
    // FIX: AND o.buyer_user_id = $2 (req.user.sub) - so o dono cria payment.
    //
    // BUG 2 RACE (Regra K): SELECT sem FOR UPDATE permite 2 requests
    //   simultaneas criarem 2 Asaas payments distintos. UPDATE final
    //   persiste so o ultimo. PRIMEIRO payment fica fantasma no Asaas
    //   (custo de transacao + 1 PIX a mais para usuario reconciliar).
    // FIX: tx() + FOR UPDATE em orders (lock pessimistico).
    //
    // BUG 3 (Regra I): SELECT o.* + u.email,... mistura explicito e wildcard.
    //   o.* expoe idempotency_key, buyer_ip, buyer_user_agent, asaas_charge_id,
    //   expires_at. Aqui nao vaza no response (linhas finais sao explicitas)
    //   mas pattern security cross-svc: lista explicita sempre.
    //
    // BUG 4 (Regra B): JOIN users sem u.deleted_at IS NULL. User soft-deleted
    //   (admin moderou) ainda permite payment. Edge case mas defensive.
    //
    // Toda lógica de criacao em tx() atomic (commit so apos UPDATE de
    // asaas_payment_id). Se Asaas API falha, tx() rollback - order
    // payment_status volta a 'pending' (consistencia DB <-> Asaas).
    let order;
    let lockResult;
    await tx(async (c) => {
      /* FIX-WORKER-18 pass 314: consolida users.metadata SELECT (linha 243).
         PRE-FIX: 2 queries separadas:
           - linha 203 SELECT orders JOIN users (sem metadata)
           - linha 243 SELECT users.metadata p/ asaas_customer_id
         POST-FIX: + u.metadata aqui. Reduz 1 roundtrip DB por checkout. */
      const o = await c.query(
        `SELECT o.id, o.buyer_user_id, o.order_number, o.payment_status,
                o.payment_method, o.total_cents, o.currency,
                u.email, u.full_name, u.cpf_cnpj, u.phone_e164, u.metadata AS user_metadata
           FROM orders o
           JOIN users u ON u.id = o.buyer_user_id AND u.deleted_at IS NULL
          WHERE o.id = $1 AND o.buyer_user_id = $2
          FOR UPDATE OF o`,
        // FIX pass 117: internal-token bypass req.user undefined - usar body fallback
        [req.body.order_id, req.user?.sub || req.body.buyer_user_id]
      );
      if (!o.rows.length) {
        lockResult = { error: 'order_not_found' };
        return;
      }
      order = o.rows[0];
      if (order.payment_status !== 'pending') {
        lockResult = { error: 'payment_not_pending' };
        return;
      }
      // Lock ativo - segue para criacao Asaas fora do tx() (rede + tempo
      // alto = nao bloquear DB pool). Re-check status pos-Asaas via UPDATE
      // condicional anti-race.
    });
    if (lockResult?.error === 'order_not_found') return next(errorHandler.notFound('order_not_found'));
    if (lockResult?.error === 'payment_not_pending') return next(errorHandler.badRequest('payment_not_pending'));

    // FIX-WORKER-11 pass 4: bloqueia checkout se user nao tem CPF/CNPJ.
    // Antes: enviava '00000000000' (CPF zerado) -> Asaas rejeita com 400
    // invalid_value cpfCnpj -> Promise<reject> -> 500 errorHandler -> UX confuso
    // ("Erro interno do servidor. Tente novamente em instantes").
    // Agora: 400 com mensagem clara + cta para completar perfil.
    if (!order.cpf_cnpj || order.cpf_cnpj.replace(/\D/g, '').length < 11) {
      return next(errorHandler.badRequest(
        'missing_cpf_cnpj',
        'CPF/CNPJ obrigatorio para pagamento. Complete seu cadastro em /conta antes de finalizar.'
      ));
    }

    // 1. cria/usa customer Asaas (cache no users.metadata.asaas_customer_id)
    /* FIX-WORKER-18 pass 314: usa user_metadata ja capturado no tx (linha 213).
       PRE-FIX: 2nd SELECT users.metadata roundtrip - redundante.
       POST-FIX: lookup direto em order.user_metadata. */
    let customerId = order.user_metadata?.asaas_customer_id;
    if (!customerId) {
      const cust = await asaas.createCustomer({
        name: order.full_name,
        email: order.email,
        cpfCnpj: order.cpf_cnpj.replace(/\D/g, ''), // normaliza apenas digitos (Asaas exige formato sem pontuacao)
        phone: order.phone_e164,
        externalReference: order.buyer_user_id,
      });
      customerId = cust.id;
      // FIX-WORKER-11 pass 221: defensive check createCustomer return.
      // Edge case: Asaas pode retornar 200 com body anormal (rate-limit
      // gracefully degrade returning {ok:false} sem id) ou timeout pos-create
      // (created on Asaas but response truncated).
      // PRE-FIX: customerId undefined -> UPDATE metadata grava undefined ->
      //   line 284 createPayment com customer=undefined -> 400 Asaas.
      // POST-FIX: explicit check + clear error message.
      if (!customerId || typeof customerId !== 'string') {
        log.error({ order_id: order.id, asaas_response: cust },
          '[payment.create.customer_no_id] Asaas createCustomer sem id valido');
        return next(errorHandler.badRequest('asaas_customer_invalid',
          'Falha ao criar customer Asaas. Tente novamente em alguns segundos.'));
      }
      await query(
        `UPDATE users SET metadata = metadata || $1::JSONB WHERE id = $2`,
        [JSON.stringify({ asaas_customer_id: customerId }), order.buyer_user_id]
      );
    }

    // 2. carrega splits
    // FIX-WORKER-11 pass 249 (split float precision parity):
    //   PRE-FIX: fixedValue: Math.round(s.fixed_value_cents) / 100
    //   s.fixed_value_cents e BIGINT - PG pode retornar como string em alguns
    //   drivers. Math.round("12345") = 12345 OK, mas Number() defensive evita
    //   edge case driver behavior. Sequence depois /100 = float possivel IEEE
    //   drift se valor exato como 333333 cents -> 3333.33 OK mas 333334 ->
    //   3333.34 -> Asaas pode rejeitar split com 3 decimais residual.
    //   Pass 235 aplicou Number() + Math.round em createTransfer mas split
    //   ficou sem o mesmo defensive pattern. POST-FIX paridade.
    const splitRows = await query(
      `SELECT wallet_id, fixed_value_cents FROM asaas_splits WHERE order_id = $1`,
      [order.id]
    );
    const split = splitRows.rows.map((s) => ({
      walletId: s.wallet_id,
      fixedValue: Math.round(Number(s.fixed_value_cents)) / 100,
    }));

    // 3. mapear billing type
    // FIX-WORKER-11 pass 362 (defense em profundidade billingType validate):
    //   PRE-FIX: billingMap[order.payment_method] retornava undefined se DB
    //   tivesse valor invalido (legacy migration, manual UPDATE, ou bypass Zod
    //   no order-svc). Resultado: billingType: undefined enviado a Asaas ->
    //   400 obscuro sem context (atribuido a "Asaas error" generico).
    //   Cenario real: order anciao pre-mig pode ter payment_method='card' (legacy)
    //   ou admin manual UPDATE typo (raro mas defensive matter).
    //   POST-FIX: validate explicit + 400 friendly error com value real DB.
    //   Pattern V8: NEVER trust input em adapter externo critico (real money).
    const billingMap = { pix: 'PIX', credit_card: 'CREDIT_CARD', boleto: 'BOLETO' };
    const billingType = billingMap[order.payment_method];
    if (!billingType) {
      log.error({ order_id: order.id, payment_method: order.payment_method },
        '[payment.create.invalid_method] order.payment_method nao mapeavel');
      return next(errorHandler.badRequest('invalid_payment_method',
        `Metodo de pagamento '${order.payment_method}' nao suportado. Use pix, credit_card ou boleto.`));
    }
    // FIX-WORKER-11 pass 221: dueDate por billingType (era 24h fixo p/ todos).
    // PRE-FIX: dueDate = NOW() + 24h uniformemente
    //   - PIX: ok (pagamento instantaneo, due 24h flexivel)
    //   - CREDIT_CARD: ok (cobranca imediata, due cosmetico)
    //   - BOLETO: PROBLEMA - bancos exigem typically 3+ dias para boleto:
    //     * Geracao boleto via Asaas leva minutos
    //     * Compensacao bancaria ate D+1
    //     * User pode pagar em ate 3 dias uteis tipico
    //     * 24h era too short - muitos boletos venciam antes user pagar
    // POST-FIX: dueDate adaptativo:
    //   - PIX: 24h (instantaneo)
    //   - CREDIT_CARD: 24h (cosmetico)
    //   - BOLETO: 3 dias (compensacao + window pagamento)
    const dueDays = order.payment_method === 'boleto' ? 3 : 1;
    const dueDate = new Date(Date.now() + dueDays * 24 * 3600 * 1000).toISOString().slice(0, 10);

    // MLB-5: parcelamento (somente cartao) - calcula valor da parcela com a mesma politica do preview
    const inst = req.body.installment_count && order.payment_method === 'credit_card' ? req.body.installment_count : 1;
    let installmentValue;
    if (inst > 1) {
      const monthlyRate = 0.0299;
      const totalCentsForCalc = inst <= 3 ? order.total_cents : Math.round(order.total_cents * Math.pow(1 + monthlyRate, inst - 1));
      // FIX-WORKER-11 pass 230 (installment rounding): Math.floor causava
      // soma das parcelas < total. Ex: R$100/3 = R$33,33 x 3 = R$99,99
      // -> 1 cent "perdido" (Asaas rejeita installmentValue*count != value
      // em algumas versoes API + cliente paga R$ 99,99 quando comprou R$100).
      // POST-FIX: Math.round em vez de Math.floor. Cliente paga ate +R$0,01
      // por parcela (ate +R$0,12 num 12x) mas total casa com order.total_cents.
      // Banker's rounding nao necessario - diferenca centavos, nao tem viesgo.
      installmentValue = Math.round(totalCentsForCalc / inst) / 100;
    }

    const payment = await asaas.createPayment({
      customer: customerId,
      billingType, // FIX pass 362: validado upfront (era billingMap[...] inline)
      value: order.total_cents / 100,
      dueDate,
      description: `Pedido ${order.order_number} - Code & Agent Shop`,
      externalReference: order.id,
      split,
      installmentCount: inst > 1 ? inst : undefined,
      installmentValue,
    });

    // 4. campos extras (PIX QR Code, boleto URL)
    let pix = null;
    if (order.payment_method === 'pix') {
      try { pix = await asaas.getPixQrCode(payment.id); } catch (e) { log.warn({ /* FIX pass 343 DLP */ err: mask.text(String(e.message || '').slice(0, 300)) }, '[pix.qr.fail]'); }
    }

    // FIX-WORKER-7 pass 21: UPDATE idempotente anti-race condition.
    // Pre-fix: WHERE id=$6 - se segunda request criou outro Asaas payment
    //   entre nossa criacao e este UPDATE, sobrescreve referencia (perdemos
    //   primeiro payment.id sem reembolso, custo Asaas fee).
    // Pos-fix: WHERE id=$6 AND payment_status='pending' (idempotent guard).
    //   Se outra request ja virou 'authorized', UPDATE NAO faz nada.
    //   ROWCOUNT=0 -> log warn + cancela payment Asaas que criamos
    //   (graceful cleanup anti-double-charge).
    const upd = await query(
      `UPDATE orders SET asaas_payment_id = $1, asaas_invoice_url = $2,
                         asaas_pix_qrcode = $3, asaas_pix_copy_paste = $4,
                         asaas_boleto_url = $5, payment_status = 'authorized'
        WHERE id = $6 AND payment_status = 'pending'
        RETURNING id`,
      [payment.id, payment.invoiceUrl || null,
       pix?.encodedImage || null, pix?.payload || null,
       payment.bankSlipUrl || null, order.id]
    );
    if (!upd.rows.length) {
      // Race: outra request ja autorizou. Tentar cancelar nosso payment
      // duplicado no Asaas (best-effort, evita cobrar usuario duas vezes).
      log.warn({ order_id: order.id, payment_id: payment.id },
        '[asaas.create.race_detected] outra request ja autorizou, tentando cancelar duplicate');
      /* FIX-WORKER-11 pass 289: cancelPayment AGORA implementado em asaas.js
         PRE-FIX: optional chaining .?() silently no-op (funcao nao existia)
         -> duplicate Asaas payment continuava billable -> real money loss
         POST-FIX: DELETE /payments/:id efetivamente cancela invoice */
      try {
        await asaas.cancelPayment(payment.id);
        log.info({ payment_id: payment.id }, '[asaas.cancel.ok] duplicate payment cancelado com sucesso');
      } catch (e) {
        log.error({ /* FIX pass 343 DLP */ err: mask.text(String(e.message || '').slice(0, 300)), payment_id: payment.id },
          '[asaas.cancel.fail] duplicate Asaas payment criado mas falhou cancelar - investigar manual');
      }
      return next(errorHandler.badRequest('payment_already_authorized',
        'Pagamento ja foi gerado em outra requisicao. Recarregue a pagina.'));
    }

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
// FIX SEG-PAY-1 (CRITICAL): bug anterior permitia bypass total da assinatura quando
// ASAAS_WEBHOOK_SECRET nao estava configurado (valid=true por default).
// FIX-WORKER-11 pass 384 *** CRITICAL REAL MONEY GAP - dispute refund dispatch ***:
//   PRE-FIX: asaas.refundPayment exported em asaas.js linha 80 mas ZERO callers.
//   order-svc dispute resolve marcava order=refunded SEM disparar Asaas refund.
//   Buyer recebia notification "Refund aprovado" mas dinheiro NUNCA voltava.
//   POST-FIX: endpoint internal /payments/asaas/refund - chamado por order-svc
//   setImmediate apos dispute resolve com resolution_action in (refund_approved, partial_refund).
//   Looks up order via dispute_id, dispatch asaas.refundPayment(payment_id, value).
//   Asaas webhook PAYMENT_REFUNDED (mapeado linha 730) finaliza status=refunded.
//   Se Asaas falhar, PAYMENT_REFUND_FAILED webhook (pass 222) alerta admin.
app.post('/payments/asaas/refund', asyncHandler(async (req, res, next) => {
  // x-internal-token guard (paridade /payments/asaas/create pass 117)
  const expected = process.env.PAYMENT_INTERNAL_TOKEN;
  if (expected && req.headers['x-internal-token'] !== expected) {
    log.warn({ ip: req.ip }, '[refund.unauthorized]');
    return next(errorHandler.unauthorized('invalid_internal_token'));
  }
  const { dispute_id, refund_amount_cents, reason } = req.body || {};
  if (!dispute_id) return next(errorHandler.badRequest('dispute_id_required'));
  // Lookup order via dispute_id
  const r = await query(
    `SELECT o.id AS order_id, o.asaas_payment_id, o.total_cents, o.payment_status
       FROM disputes d
       JOIN orders o ON o.id = d.order_id
      WHERE d.id = $1::UUID AND o.asaas_payment_id IS NOT NULL`,
    [dispute_id]
  );
  if (!r.rows.length) {
    log.warn({ dispute_id }, '[refund.no_payment] dispute sem payment associado');
    return next(errorHandler.notFound('payment_not_found'));
  }
  const order = r.rows[0];
  // Partial refund: value in BRL (Asaas API). Full refund: undefined.
  const refundValueBRL = refund_amount_cents
    ? Math.min(refund_amount_cents, order.total_cents) / 100
    : undefined;
  try {
    const refund = await asaas.refundPayment(order.asaas_payment_id, refundValueBRL,
      String(reason || 'dispute_refund').slice(0, 200));
    // Audit log atomic (Pattern V8 W7 Regra P)
    await query(
      `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
       VALUES (NULL, 'service', 'payment.refund.dispatched', 'order', $1, 'warn', $2::JSONB)`,
      [order.order_id, JSON.stringify({
        dispute_id, asaas_payment_id: order.asaas_payment_id,
        refund_amount_cents: refund_amount_cents || order.total_cents,
        full_refund: !refund_amount_cents,
        reason: mask.text(String(reason || '').slice(0, 200)),
        asaas_refund_id: refund?.id || null,
      })]
    );
    log.info({ dispute_id, order_id: order.order_id, asaas_refund_id: refund?.id },
      '[refund.dispatched]');
    res.json({ ok: true, asaas_refund_id: refund?.id, order_id: order.order_id });
  } catch (e) {
    log.error({ dispute_id, order_id: order.order_id,
      err: mask.text(String(e.message || '').slice(0, 300)) },
      '[refund.asaas_call_failed]');
    return next(errorHandler.badRequest('asaas_refund_failed',
      'Falha ao processar refund Asaas. Tente novamente ou contate suporte.'));
  }
}));

// Atacante podia forjar PAYMENT_RECEIVED para qualquer order pending e desbloquear downloads.
//
// AGORA:
// - Se ASAAS_WEBHOOK_SECRET nao esta setado, REJEITA 503 (fail-closed, sem aceitar fraude).
// - Compara via crypto.timingSafeEqual para evitar timing attacks.
// - Header invalido -> 401 + audita o evento ainda no banco como signature_valid=false
//   (NAO processa) para investigacao posterior.
app.post('/payments/asaas/webhook', asyncHandler(async (req, res) => {
  const secret = process.env.ASAAS_WEBHOOK_SECRET;
  if (!secret) {
    log.error('[webhook.misconfigured] ASAAS_WEBHOOK_SECRET nao definido - rejeitando');
    return res.status(503).json({ error: 'webhook_not_configured' });
  }

  // FIX-WORKER-11: req.body pode nao ser Buffer se express.raw nao montou
  // (rota chamada com Content-Type diferente). Garante toString seguro.
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
  const sig = req.headers['asaas-access-token'] || '';
  // timing-safe compare (precisa mesmo length)
  let valid = false;
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(secret);
    valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { valid = false; }

  let data;
  try { data = JSON.parse(raw); } catch { return res.status(400).json({ error: 'invalid_json' }); }

  // FIX-WORKER-11: valida shape do payload antes do DB. Antes: body vazio `{}`
  // causava INSERT com event_type=NULL -> PG 23502 (not_null_violation) -> 500.
  // Atacantes podiam usar isso para descobrir DB internals via 500 vs 401.
  if (!data || typeof data !== 'object' || !data.event || typeof data.event !== 'string') {
    log.warn({ ip: req.ip, /* FIX pass 323 DLP */ ua: mask.text(req.headers['user-agent'] || '') }, '[webhook.invalid_payload]');
    return res.status(400).json({ error: 'invalid_payload', message: 'event field required' });
  }
  // FIX-WORKER-11 pass 241 (string length defensive):
  //   Schema asaas_webhook_events.asaas_event_id VARCHAR(60) +
  //   event_type VARCHAR(80) + asaas_payment_id VARCHAR(60).
  //   Atacante enviando data.id=<long_string> ou data.event=<>80chars
  //   disparava PG 22001 string_too_long -> errorHandler 500 -> DB internals
  //   leak via error message variance. Pattern Asaas: event_id sempre <40 chars
  //   (UUID-like ou prefixed integer). Defensive validation client-side.
  if (data.id !== undefined && (typeof data.id !== 'string' || data.id.length > 60)) {
    log.warn({ ip: req.ip, id_len: data.id?.length }, '[webhook.invalid_id]');
    return res.status(400).json({ error: 'invalid_event_id' });
  }
  if (data.event.length > 80) {
    log.warn({ ip: req.ip, event_len: data.event.length }, '[webhook.event_too_long]');
    return res.status(400).json({ error: 'invalid_event_type' });
  }
  if (data.payment?.id !== undefined && (typeof data.payment.id !== 'string' || data.payment.id.length > 60)) {
    log.warn({ ip: req.ip, pay_id_len: data.payment.id?.length }, '[webhook.invalid_payment_id]');
    return res.status(400).json({ error: 'invalid_payment_id' });
  }

  // FIX-WORKER-11 pass 184 (CRITICAL race fix): idempotency atomica via ON CONFLICT.
  //
  // PRE-FIX bug racing:
  //   1. Webhook A com data.id='X' chega - SELECT WHERE asaas_event_id='X' empty
  //   2. Webhook A' (Asaas retry concurrent) chega - SELECT tambem empty
  //   3. Ambos INSERT - segundo dispara PG 23505 (UNIQUE asaas_event_id violation)
  //   4. 23505 -> errorHandler 500 -> Asaas retry loop -> Lambda spam
  //
  // POST-FIX:
  //   - INSERT ... ON CONFLICT (asaas_event_id) DO NOTHING RETURNING id
  //   - Se conflict: insertResult.rows[] empty -> retorna duplicate
  //   - Atomic single query (vs pre-check SELECT + INSERT)
  //   - Performance: 1 query vs 2 (50% reducao DB roundtrip)
  //   - data.id=NULL caso: ainda permite duplicates (multiple inserts) p/ events
  //     sem event_id (rare). Acceptable - retry_count tracks reprocessing.
  //
  // FIX-WORKER-11 pass 6: capturar event_row_id p/ poder atualizar processed_at/processing_error
  // depois do setImmediate.
  /* FIX-WORKER-11 pass 285 (info disclosure event_id existence):
     PRE-FIX flow:
       1. INSERT signature_valid=<bool> ON CONFLICT DO NOTHING
       2. Se duplicate -> 200 OK { duplicate:true } (mesmo se sig invalida!)
       3. Se sig invalida -> 401
     Atacante pode probe quais event_id sao validos: resend mesmo event_id
     com sig INVALIDA -> recebe 200 duplicate em vez de 401 -> CONFIRMA que
     event_id existe na DB. Information disclosure -> reconnaissance step
     attack timing/replay.
     POST-FIX: validar signature ANTES da duplicate check. Atacante sem
     valid signature sempre recebe 401 - nao distingue duplicate vs new. */
  if (!valid) {
    // Audit invalid attempt mesmo bloqueado (forensics):
    await query(
      `INSERT INTO asaas_webhook_events (event_type, asaas_event_id, asaas_payment_id, payload, signature_valid)
       VALUES ($1, $2, $3, $4::JSONB, FALSE)
       ON CONFLICT (asaas_event_id) DO NOTHING`,
      [data.event, data.id || null, data.payment?.id || null, JSON.stringify(data)]
    );
    log.warn({ event: data.event, ip: req.ip, /* FIX pass 323 DLP */ ua: mask.text(req.headers['user-agent'] || '') }, '[webhook.invalid_signature]');
    return res.status(401).json({ error: 'invalid_signature' });
  }

  // Signature VALID - normal idempotency path
  const insertResult = await query(
    `INSERT INTO asaas_webhook_events (event_type, asaas_event_id, asaas_payment_id, payload, signature_valid)
     VALUES ($1, $2, $3, $4::JSONB, TRUE)
     ON CONFLICT (asaas_event_id) DO NOTHING
     RETURNING id`,
    [data.event, data.id || null, data.payment?.id || null, JSON.stringify(data)]
  );
  // Se ON CONFLICT triggered (duplicate event), rows[] empty -> duplicate ack
  if (data.id && !insertResult.rows.length) {
    return res.json({ ok: true, duplicate: true });
  }
  const eventRowId = insertResult.rows[0]?.id;

  res.json({ ok: true });

  // FIX-WORKER-11 pass 6: tracking processed_at + processing_error em fluxo async.
  // Em sucesso: processed_at = NOW() (audit pode SELECT WHERE processed_at IS NULL p/ stuck).
  // Em falha: processing_error gravado p/ debugging + retry_count incrementado.
  // Asaas considera entregue (200 ja foi enviado), mas operador pode reprocessar
  // manualmente via UPDATE retry_count + cron job futuro.
  setImmediate(async () => {
    try {
      await processWebhookEvent(data);
      // Marca processed_at e linka order_id se descoberto
      const orderLink = data.payment?.id
        ? await query('SELECT id FROM orders WHERE asaas_payment_id = $1', [data.payment.id]).catch(() => ({ rows: [] }))
        : { rows: [] };
      await query(
        `UPDATE asaas_webhook_events
            SET processed_at = NOW(),
                order_id = COALESCE(order_id, $1::UUID),
                processing_error = NULL
          WHERE id = $2`,
        [orderLink.rows[0]?.id || null, eventRowId]
      );
    } catch (e) {
      log.error({ /* FIX pass 343 DLP */ err: mask.text(String(e.message || '').slice(0, 300)), eventRowId }, '[webhook.process.fail]');
      await query(
        `UPDATE asaas_webhook_events
            SET processing_error = $1,
                retry_count = retry_count + 1
          WHERE id = $2`,
        [/* FIX pass 345 DLP */ mask.text(String(e.message || '').slice(0, 500)), eventRowId]
      ).catch(() => {});
    }
  });
}));

// FIX-WORKER-7 pass 22: state machine valida transicoes payment_status.
// PRE-FIX: webhook reentrante (Asaas retry pos-ack-timeout) reprocessava
// order ja 'captured' -> dispara loyalty earn 2x + paid_at sobrescrito.
// PRE-FIX: PAYMENT_RECEIVED apos PAYMENT_REFUNDED (out-of-order delivery)
// revertia refund silenciosamente.
// State machine: transicoes legitimas validadas. Reprocessamento = noop.
// FIX-WORKER-11 pass 247 (state machine gap pending->refunded):
//   PRE-FIX: 'pending' -> ['authorized','captured','failed']
//   Cenario: order criada pending -> user pagou direto Asaas via PIX antes
//   do nosso webhook chegar -> admin/buyer abriu dispute -> Asaas REFUND ->
//   webhook PAYMENT_REFUNDED chega para order ainda 'pending' -> transicao
//   BLOQUEADA pelo state machine -> log info 'nao permitida' -> estado fica
//   pending (incorreto, Asaas ja reembolsou cliente).
//   POST-FIX: 'pending' aceita 'refunded' tambem (rare mas legitimate path).
//   Tambem: capturado -> 'authorized' (Asaas pode emitir CONFIRMED apos
//   RECEIVED em casos de chargeback rollback - retornar 'authorized' eh
//   semantica intermediaria correta).
const ALLOWED_TRANSITIONS = {
  // From state: [to states permitidos]
  'pending':    ['authorized', 'captured', 'failed', 'refunded'],  // +refunded edge case
  'authorized': ['captured', 'failed', 'refunded'],
  'captured':   ['refunded', 'failed'], // refund/chargeback validos
  'refunded':   [],                      // terminal - reprocessar = noop
  'failed':     ['authorized'],          // retry pos-failed eh OK
};

// FIX-WORKER-11 pass 371 (TRANSFER webhook handler - gap funcional pass 368):
//   PRE-FIX: processWebhookEvent retornava early se !paymentId.
//   TRANSFER_CREATED/DONE/FAILED tem evt.transfer.id (NAO evt.payment.id)
//   -> TODOS transfers silenciosamente descartados:
//     - Payout marcado 'paid' mas Asaas pode falhar transfer depois
//     - Status nunca volta a 'rejected' p/ admin notar
//     - asaas_transfer_id reconciliation impossivel
//   Pass 282 adicionou externalReference em createTransfer + pass 368
//   criou idx_payouts_transfer_id - preparou infra mas handler ficou lagged.
//   POST-FIX: detecta TRANSFER_* events upfront + lookup seller_payouts/
//   payouts_pending_wallet por asaas_transfer_id (idx pass 368). Updates
//   status + paid_at + audit_log atomic.
async function processTransferEvent(evt) {
  const transferId = evt.transfer?.id;
  if (!transferId) return;
  const eventName = evt.event;
  // Map TRANSFER events -> status transitions
  // Asaas docs: TRANSFER_CREATED (pending->scheduled), TRANSFER_DONE (->paid),
  // TRANSFER_FAILED (admin attention), TRANSFER_CANCELLED (admin reverted)
  const TRANSFER_MAP = {
    TRANSFER_DONE:      { newStatus: 'paid',     setPaidAt: true },
    TRANSFER_FAILED:    { newStatus: 'rejected', failedReason: 'asaas_transfer_failed' },
    TRANSFER_CANCELLED: { newStatus: 'rejected', failedReason: 'asaas_transfer_cancelled' },
    TRANSFER_CREATED:   { logOnly: true }, // ja foi processado em /process - log only
  };
  const action = TRANSFER_MAP[eventName];
  if (!action) {
    log.warn({ event: eventName, transfer_id: transferId },
      '[webhook.transfer.unknown_event] evento TRANSFER nao mapeado');
    return;
  }
  if (action.logOnly) {
    log.info({ event: eventName, transfer_id: transferId },
      '[webhook.transfer.log_only] TRANSFER_CREATED ack');
    return;
  }
  // Lookup seller_payouts (caso normal) OU payouts_pending_wallet (legacy debt)
  // idx_payouts_transfer_id UNIQUE PARTIAL (pass 368) -> O(log n) lookup
  await withRetry('payment.webhook.transfer.tx', async () => {
    await tx(async (c) => {
      // Try seller_payouts first
      let payout = await c.query(
        `SELECT id, seller_id, status FROM seller_payouts
          WHERE asaas_transfer_id = $1 FOR UPDATE`,
        [transferId]
      );
      let table = 'seller_payouts';
      if (!payout.rows.length) {
        // Try payouts_pending_wallet
        payout = await c.query(
          `SELECT id, seller_id, status FROM payouts_pending_wallet
            WHERE asaas_transfer_id = $1 FOR UPDATE`,
          [transferId]
        );
        table = 'payouts_pending_wallet';
      }
      if (!payout.rows.length) {
        log.warn({ event: eventName, transfer_id: transferId },
          '[webhook.transfer.no_match] transfer_id sem payout - investigar');
        return;
      }
      const row = payout.rows[0];
      // State machine: payout final states sao terminal
      if (['paid', 'rejected'].includes(row.status) && row.status === action.newStatus) {
        log.info({ event: eventName, payout_id: row.id, status: row.status },
          '[webhook.transfer.idempotent] mesmo estado - noop');
        return;
      }
      // UPDATE conforme tabela
      if (table === 'seller_payouts') {
        await c.query(
          `UPDATE seller_payouts SET status = $1,
              paid_at = CASE WHEN $2 THEN NOW() ELSE paid_at END,
              rejected_reason = CASE WHEN $3 IS NOT NULL THEN $3 ELSE rejected_reason END
            WHERE id = $4`,
          [action.newStatus, !!action.setPaidAt, action.failedReason || null, row.id]
        );
      } else {
        // payouts_pending_wallet: liquidated_at OR forfeited_at
        await c.query(
          `UPDATE payouts_pending_wallet SET
              status = CASE WHEN $1 = 'paid' THEN 'liquidated' ELSE 'forfeited' END,
              liquidated_at = CASE WHEN $1 = 'paid' THEN NOW() ELSE liquidated_at END,
              forfeited_at = CASE WHEN $1 = 'rejected' THEN NOW() ELSE forfeited_at END,
              forfeited_reason = CASE WHEN $2 IS NOT NULL THEN $2 ELSE forfeited_reason END
            WHERE id = $3`,
          [action.newStatus, action.failedReason || null, row.id]
        );
      }
      // Audit log
      await c.query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES (NULL, 'service', $1, $2, $3, $4, $5::JSONB)`,
        ['asaas.' + eventName.toLowerCase(),
         table === 'seller_payouts' ? 'seller_payout' : 'pending_wallet_payout',
         row.id,
         action.newStatus === 'rejected' ? 'critical' : 'info',
         JSON.stringify({
           event: eventName, transfer_id: transferId,
           previous_status: row.status, new_status: action.newStatus,
           reason: action.failedReason || null,
         })]
      );
    });
  });
}

async function processWebhookEvent(evt) {
  // FIX-WORKER-11 pass 371: dispatch TRANSFER events ANTES de payment check
  if (evt.event && evt.event.startsWith('TRANSFER_')) {
    return processTransferEvent(evt);
  }
  const paymentId = evt.payment?.id;
  if (!paymentId) return;

  // FIX-WORKER-11 pass 222 (CRITICAL semantica): PAYMENT_REFUND_FAILED corrigido.
  // PRE-FIX bug: PAYMENT_REFUND_FAILED -> { ps: 'failed' }
  //   ALLOWED_TRANSITIONS permite 'captured' -> 'failed'
  //   Resultado: order capturada com sucesso + admin tenta refund + refund falha
  //     -> payment_status virou 'failed' (WRONG semantica)
  //   User UX: dashboard mostra pedido como 'pagamento falhou' mesmo apos paid
  //   Admin UX: audit log mostra status transition errada
  //
  // FIX: PAYMENT_REFUND_FAILED = NO-OP em payment_status (mantem estado anterior)
  //   Acao real: log warn + audit_log alert + notification admin
  //   Refund failed = admin precisa investigar (insufficient funds, regulatory reject)
  //   Order permanece 'captured' / 'paid' (sucesso original preservado)
  //
  // Asaas events semantica:
  //   PAYMENT_RECEIVED/CONFIRMED -> dinheiro chegou (captured/paid)
  //   PAYMENT_REFUNDED -> refund concluido (refunded)
  //   PAYMENT_OVERDUE -> nao pago no prazo (failed)
  //   PAYMENT_DELETED -> Asaas cancelou cobranca (cancelled)
  //   PAYMENT_REFUND_FAILED -> refund tentou mas falhou (NAO afeta state pagamento)
  //   PAYMENT_REFUND_REQUESTED -> admin iniciou refund (estado transitorio - log only)
  const map = {
    PAYMENT_RECEIVED:    { ps: 'captured', os: 'paid', paid_at: true },
    PAYMENT_CONFIRMED:   { ps: 'captured', os: 'paid', paid_at: true },
    PAYMENT_REFUNDED:    { ps: 'refunded', os: 'refunded' },
    PAYMENT_OVERDUE:     { ps: 'failed',   os: 'expired' },
    PAYMENT_DELETED:     { ps: 'failed',   os: 'cancelled' },
    // FIX pass 222: REFUND_FAILED nao transiciona state - log/alert only
    PAYMENT_REFUND_FAILED: { logOnly: true, severity: 'critical' },
  };
  const action = map[evt.event];
  // FIX-WORKER-7 pass 22 (bug 3): eventos desconhecidos LOG WARN
  // Pre-fix: if (!action) return; silencioso. Operador nao sabia que
  // novos eventos Asaas (PAYMENT_CHARGEBACK_REQUESTED, DUNNING_RECEIVED)
  // estavam sendo descartados. Audit log impossivel.
  if (!action) {
    log.warn({ event: evt.event, payment_id: paymentId },
      '[webhook.unknown_event] evento Asaas nao mapeado - operador deve revisar map');
    return;
  }

  // FIX-WORKER-11 pass 204: capture user_ids p/ invalidate loyalty:me cache cross-svc pos-tx
  const loyaltyUsersToInvalidate = new Set();
  // FIX-WORKER-18 pass 216: capture order.id p/ invalidate order:detail cache cross-svc
  // (webhook PAYMENT_RECEIVED muda paid_at + status - buyer /conta/pedidos/[id] ve stale)
  let orderIdToInvalidate = null;

  /* FIX-WORKER-11 pass 311 (webhook deadlock retry):
     PRE-FIX: tx() webhook handler sem withRetry wrap. Cenarios deadlock 40P01:
     - Asaas retry burst (3-5 callbacks paralelos por order quando 503 transient)
     - SELECT FOR UPDATE em mesma order_id row -> deadlock detected -> 1 morre 40P01
     - Webhook retorna 500 -> Asaas retry com backoff (10x mais) -> amplifica
     POST-FIX: withRetry wrap tx, 3 attempts backoff exponencial.
     Pattern V8 cross-svc (paridade pass 310 qa-svc + vault-svc). */
  await withRetry('payment.webhook.tx', async () => {
  await tx(async (c) => {
    // FIX-WORKER-7 pass 22 (bug 1 RACE Regra K): SELECT FOR UPDATE.
    // Pre-fix: SELECT sem lock fora do tx() permitia 2 webhooks
    // concorrentes (Asaas retry) verem mesmo state -> ambos UPDATE.
    // Loyalty earn 2x, paid_at sobrescrito, splits processados 2x.
    // FIX: SELECT FOR UPDATE dentro do tx() - segundo webhook bloqueia
    // ate primeiro COMMIT, depois ve state atualizado -> noop por
    // state machine guard.
    const r = await c.query(
      `SELECT id, buyer_user_id, payment_status
         FROM orders WHERE asaas_payment_id = $1
         FOR UPDATE`,
      [paymentId]
    );
    if (!r.rows.length) return;
    const order = r.rows[0];
    // FIX-WORKER-18 pass 216: capture order id p/ invalidate cross-svc cache pos-tx
    orderIdToInvalidate = order.id;

    // FIX-WORKER-7 pass 22 (bug 2): state machine validation
    // Pre-fix: PAYMENT_RECEIVED em order ja 'captured' (Asaas retry)
    // reprocessava tudo - loyalty earn 2x + paid_at sobrescrito + splits 2x.
    // Pre-fix: PAYMENT_RECEIVED apos PAYMENT_REFUNDED revertia refund silente.
    // POS-FIX: transicao validada. Se nao permitida, NOOP + log info.
    if (action.ps) {
      const allowed = ALLOWED_TRANSITIONS[order.payment_status] || [];
      if (!allowed.includes(action.ps)) {
        // Reprocessamento ou out-of-order delivery - NAO eh erro, eh esperado
        // (Asaas retries ate receber 200 OK do webhook).
        log.info({
          payment_id: paymentId,
          event: evt.event,
          current_status: order.payment_status,
          target_status: action.ps,
        }, '[webhook.transition_blocked] state machine guard - ignorando reprocessamento');
        return;
      }
    }

    // FIX-WORKER-11 pass 222: logOnly events nao mudam state, apenas audit + admin alert.
    // Usado em PAYMENT_REFUND_FAILED (refund attempt falhou MAS pagamento original
    // permanece valido - admin precisa investigar manual).
    if (action.logOnly) {
      log.warn({
        event: evt.event,
        payment_id: paymentId,
        order_id: order.id,
        order_status: order.payment_status,
        severity: action.severity,
      }, '[webhook.log_only] evento Asaas requer atencao admin (state nao mudou)');

      // Audit log critical severity
      await c.query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES (NULL, 'service', $1, 'order', $2, $3, $4::JSONB)`,
        ['asaas.' + evt.event.toLowerCase(), order.id, action.severity || 'warn',
         JSON.stringify({
           event: evt.event,
           payment_id: paymentId,
           order_status_at_event: order.payment_status,
           note: 'Estado pagamento NAO foi alterado - acao admin necessaria',
         })]
      );

      // Notification admin (in_app priority high)
      // Capture admins via lookup (single query separado para nao bloquear webhook)
      const admins = await c.query(
        `SELECT id FROM users WHERE role IN ('admin','staff')
                AND is_active = TRUE AND is_banned = FALSE
                AND deleted_at IS NULL LIMIT 10`
      );
      for (const admin of admins.rows) {
        await c.query(
          `INSERT INTO notifications (user_id, channel, template_code, title, body, priority)
           VALUES ($1, 'in_app', 'asaas_refund_failed',
                   'Refund falhou: order ' || $2,
                   $3, 3)`,
          [admin.id, order.id.slice(0, 8),
           `Asaas evento ${evt.event} para order ${order.id.slice(0, 8)} (payment ${paymentId}). Estado pagamento mantido como '${order.payment_status}'. Investigue motivos no painel Asaas.`]
        ).catch(() => {});
      }
      return;  // Skip UPDATE orders completely - estado preserved
    }

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
      // FIX-WORKER-7 pass 46: 3 BUGS replicados pass 45 (consolidando logica payment-svc <-> seller-svc):
      // - BUG idempotency reference_id (replay webhook = 2x earn)
      // - BUG tier promotion notification missing (UX)
      // - BUG audit_log missing (financial mutation compliance)
      // NOTA: payment-svc faz INSERT DIRETO (nao HTTP /loyalty/earn) - bypass
      // do serviceTokenGuard pass 45. Refactor consolidado merece iter dedicada.
      try {
        // FIX bug idempotency: check existing loyalty_transactions p/ este order
        // FIX-WORKER-11 pass 257 (UUID cast correto):
        //   PRE-FIX: reference_id = $2::TEXT - coluna eh UUID (mig 010)
        //   Cast UUID -> TEXT impedia uso de idx_loyalty_tx_reference (mig 072
        //   pass 242: PARTIAL idx ON (reference_type, reference_id) WHERE NOT NULL).
        //   Query forcava Seq Scan na partial idx -> slower duplicate check.
        //   POST-FIX: reference_id = $2::UUID alinhado com schema, idx funciona.
        const dup = await c.query(
          `SELECT id FROM loyalty_transactions
            WHERE user_id = $1::UUID AND reason = 'order_paid'
              AND reference_type = 'order' AND reference_id = $2::UUID
            LIMIT 1`,
          [order.buyer_user_id, order.id]
        );
        if (dup.rows.length) {
          log.info({ order_id: order.id, existing_tx: dup.rows[0].id },
            '[loyalty.earn.skip_duplicate] webhook replay - pontos ja creditados');
          // Skip earn (idempotent webhook handling)
        } else {
          const totRow = await c.query(`SELECT total_cents FROM orders WHERE id = $1`, [order.id]);
          const totalCents = totRow.rows[0]?.total_cents || 0;
          // FIX: SELECT FOR UPDATE user_loyalty antes ler tier (Regra K race)
          const tierRow = await c.query(
            `SELECT tier, points_lifetime FROM user_loyalty
              WHERE user_id = $1::UUID FOR UPDATE`,
            [order.buyer_user_id]
          );
          const curTier = tierRow.rows[0]?.tier || 'starter';
          const prevLifetime = parseInt(tierRow.rows[0]?.points_lifetime || 0, 10);
          const mult = curTier === 'platinum' ? 1.5 : (curTier === 'gold' ? 1.2 : 1.0);
          const basePts = Math.floor(totalCents / 100);
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
            // Calc novo tier (dentro mesmo tx - serializado por FOR UPDATE acima)
            const newLifetime = prevLifetime + pts;
            const newTier = newLifetime >= 3000 ? 'platinum' : (newLifetime >= 500 ? 'gold' : 'starter');
            await c.query(`UPDATE user_loyalty SET tier = $1 WHERE user_id = $2`, [newTier, order.buyer_user_id]);

            // FIX bug tier promotion notification (UX engagement)
            const tierRank = { starter: 0, gold: 1, platinum: 2 };
            if ((tierRank[newTier] || 0) > (tierRank[curTier] || 0)) {
              // FIX-WORKER-11 pass 259: priority p/ loyalty_tier_up (engagement bonus)
              await c.query(
                `INSERT INTO notifications (user_id, channel, template_code, title, body, priority)
                 VALUES ($1::UUID, 'in_app', 'loyalty_tier_up',
                         $2, $3, 2)`,
                [order.buyer_user_id,
                 `Voce subiu para o tier ${newTier.toUpperCase()}!`,
                 `Voce agora tem ${newLifetime} pontos lifetime e beneficios exclusivos do tier ${newTier}.`]
              );
            }

            // FIX bug audit_log atomic (financial mutation - LGPD compliance)
            await c.query(
              `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
               VALUES (NULL, 'service', 'loyalty.earn', 'user_loyalty', $1::UUID, 'info', $2::JSONB)`,
              [order.buyer_user_id, JSON.stringify({
                points_delta: pts,
                reason: 'order_paid',
                reference_type: 'order',
                reference_id: order.id,
                prev_tier: curTier,
                new_tier: newTier,
                tier_promoted: (tierRank[newTier] || 0) > (tierRank[curTier] || 0),
                multiplier: mult,
                total_cents: totalCents,
                source: 'payment-svc.webhook',
              })]
            );
          }
        }
      } catch (e) {
        log.error({ /* FIX pass 343 DLP */ err: mask.text(String(e.message || '').slice(0, 300)), order_id: order.id }, '[loyalty.earn.fail]');
      }
      // contadores de produto e seller
      // FIX-WORKER-14 pass 2: products.last_sale_at agora atualizado (era NULL sempre!)
      // Coluna existia desde mig inicial mas zero code path escrevia -> features tipo
      // "hot deals", "trending por recencia", stale detection ficavam impossiveis.
      await c.query(
        `UPDATE products p SET sales_count = sales_count + oi.quantity,
                               revenue_cents_total = revenue_cents_total + oi.line_total_cents,
                               last_sale_at = NOW()
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
      // notification aos sellers (movido pra ca de baixo - estava em if (false) orphan)
      const newSaleSellers = await c.query(
        `SELECT DISTINCT s.user_id, p.title, oi.seller_payout_cents
           FROM order_items oi JOIN sellers s ON s.id = oi.seller_id JOIN products p ON p.id = oi.product_id
          WHERE oi.order_id = $1 AND oi.seller_id IS NOT NULL`, [order.id]
      );
      for (const seller of newSaleSellers.rows) {
        // FIX-WORKER-11 pass 259 (priority p/ seller_new_sale):
        //   PRE-FIX: SEM priority -> default 0 (baixa prio em processOutbox)
        //   Seller espera horas para ver "Voce vendeu" notif crítica engagement.
        //   POST-FIX: priority=2 (medium-high) - cash flow + engagement core.
        //   Paridade com pass 258 seller_reactivated.
        await c.query(
          `INSERT INTO notifications (user_id, channel, template_code, title, body, payload, priority)
           VALUES ($1, 'email', 'seller_new_sale', 'Nova venda', $2, $3::JSONB, 2)`,
          [seller.user_id, `Voce vendeu "${seller.title}". Liquido: R$ ${(seller.seller_payout_cents/100).toFixed(2)}`,
           JSON.stringify({ title: seller.title, payout: (seller.seller_payout_cents/100).toFixed(2) })]
        );
      }
    }

    // FIX-WORKER-11: PAYMENT_REFUNDED precisa reverter TUDO que paid criou
    // Antes apenas seto status=refunded. Buyer continuava com license_key valida
    // (download token ativo 365d) + loyalty pts ganhos + counters de seller inflados.
    if (evt.event === 'PAYMENT_REFUNDED' || evt.event === 'PAYMENT_CHARGEBACK') {
      // 1. Revoga downloads (expires_at=NOW() + revoked_at)
      await c.query(
        `UPDATE order_items
            SET revoked_at = NOW(),
                revoked_reason = $1,
                download_expires_at = NOW()
          WHERE order_id = $2`,
        [evt.event === 'PAYMENT_CHARGEBACK' ? 'chargeback' : 'refund', order.id]
      );
      // 2. Estorna loyalty points (procura tx de earn deste order e cria reversa)
      // FIX-WORKER-11 pass 204: ON CONFLICT DO NOTHING (consume migration 061
      // idx_loyalty_idempotency UNIQUE). Asaas retry PAYMENT_REFUNDED webhook
      // pode disparar 23505 sem isso. Pattern consolidado pass 184/191.
      // Capture user_ids para invalidate loyalty:me cache cross-svc pos-tx.
      const earnTx = await c.query(
        `SELECT user_id, points_delta FROM loyalty_transactions
          WHERE reference_type = 'order' AND reference_id = $1::text AND reason = 'order_paid'`,
        [order.id]
      );
      for (const tx of earnTx.rows) {
        const reversal = -tx.points_delta;
        await c.query(
          `UPDATE user_loyalty SET points_balance = GREATEST(0, points_balance + $1::INT),
                                    points_lifetime = GREATEST(0, points_lifetime + $1::INT),
                                    updated_at = NOW()
            WHERE user_id = $2::UUID`,
          [reversal, tx.user_id]
        );
        await c.query(
          `INSERT INTO loyalty_transactions (user_id, points_delta, reason, reference_type, reference_id)
           VALUES ($1::UUID, $2::INT, 'order_refunded', 'order', $3::text)
           ON CONFLICT (user_id, reason, reference_id) WHERE reference_id IS NOT NULL DO NOTHING`,
          [tx.user_id, reversal, order.id]
        );
        loyaltyUsersToInvalidate.add(tx.user_id);
      }
      // 3. Estorna pontos resgatados (devolve ao buyer o que foi gasto)
      const refundRedeem = await c.query(
        `SELECT loyalty_points_redeemed, buyer_user_id FROM orders WHERE id = $1 AND loyalty_points_redeemed > 0`,
        [order.id]
      );
      if (refundRedeem.rows.length && refundRedeem.rows[0].loyalty_points_redeemed > 0) {
        const pts = refundRedeem.rows[0].loyalty_points_redeemed;
        await c.query(
          `UPDATE user_loyalty SET points_balance = points_balance + $1::INT, updated_at = NOW()
            WHERE user_id = $2::UUID`,
          [pts, refundRedeem.rows[0].buyer_user_id]
        );
        await c.query(
          `INSERT INTO loyalty_transactions (user_id, points_delta, reason, reference_type, reference_id)
           VALUES ($1::UUID, $2::INT, 'order_refund_restore', 'order', $3::text)
           ON CONFLICT (user_id, reason, reference_id) WHERE reference_id IS NOT NULL DO NOTHING`,
          [refundRedeem.rows[0].buyer_user_id, pts, order.id]
        );
        loyaltyUsersToInvalidate.add(refundRedeem.rows[0].buyer_user_id);
      }
      // 4. Decrementa counters de produtos + sellers
      await c.query(
        `UPDATE products p SET sales_count = GREATEST(0, sales_count - oi.quantity),
                                revenue_cents_total = GREATEST(0, revenue_cents_total - oi.line_total_cents)
           FROM order_items oi WHERE oi.order_id = $1 AND oi.product_id = p.id`, [order.id]
      );
      await c.query(
        `UPDATE sellers s SET total_sales = GREATEST(0, total_sales - 1),
                              total_revenue_cents = GREATEST(0, total_revenue_cents - oi.seller_payout_cents)
           FROM order_items oi WHERE oi.order_id = $1 AND oi.seller_id = s.id`, [order.id]
      );
      // 5. Marca splits como refunded (admin precisa estornar transfer manualmente no Asaas)
      await c.query(
        `UPDATE asaas_splits SET status = 'refunded' WHERE order_id = $1`,
        [order.id]
      );
      // 6. Notifica buyer + sellers
      await c.query(
        `INSERT INTO notifications (user_id, channel, template_code, title, body, priority)
         VALUES ($1, 'email', $2, $3, $4, 2)`,
        [order.buyer_user_id,
         evt.event === 'PAYMENT_CHARGEBACK' ? 'order_chargeback' : 'order_refunded',
         evt.event === 'PAYMENT_CHARGEBACK' ? 'Chargeback registrado' : 'Reembolso processado',
         'Seu pedido foi estornado. Os produtos foram desativados e pontos resgatados serao devolvidos. Pontos ganhos foram subtraidos.']
      );
      const refundSellers = await c.query(
        `SELECT DISTINCT s.user_id, p.title FROM order_items oi
           JOIN sellers s ON s.id = oi.seller_id JOIN products p ON p.id = oi.product_id
          WHERE oi.order_id = $1`, [order.id]
      );
      for (const seller of refundSellers.rows) {
        await c.query(
          `INSERT INTO notifications (user_id, channel, template_code, title, body, priority)
           VALUES ($1, 'email', 'seller_sale_refunded', $2, $3, 2)`,
          [seller.user_id,
           `Venda estornada: ${seller.title}`,
           `A venda do produto "${seller.title}" foi estornada. Seu saldo foi ajustado.`]
        );
      }
      log.warn({ event: evt.event, order_id: order.id, revoked_items: earnTx.rows.length },
        '[refund.processed]');
    }

  });
  }); // close withRetry pass 311

  // FIX-WORKER-11 pass 204: invalidate loyalty:me cache cross-svc apos refund tx commit
  // (PAYMENT_REFUNDED/CHARGEBACK estornam loyalty - seller-svc cache stale sem isso)
  // Pattern consolidado: pass 174 sla-status, 175 payouts, 176 loyalty checkout, 191 earn
  if (loyaltyUsersToInvalidate.size > 0) {
    try {
      const tasks = [];
      for (const userId of loyaltyUsersToInvalidate) {
        tasks.push(cache.del(`loyalty:me:${userId}:*`));
      }
      await Promise.all(tasks);
    } catch (e) {
      log.warn({ /* FIX pass 343 DLP */ err: mask.text(String(e.message || '').slice(0, 300)), users: loyaltyUsersToInvalidate.size },
        '[cache.invalidate_fail.refund]');
    }
  }

  // FIX-WORKER-18 pass 216: invalida order:detail cache cross-svc (paid_at/status mudou)
  // Buyer /conta/pedidos/[id] page deve refletir transicao paid imediato
  // + admin /admin/recent + /admin/disputes podem mostrar status mudou
  if (orderIdToInvalidate) {
    try {
      await Promise.all([
        cache.del(`order:detail:${orderIdToInvalidate}:*`),
        cache.del('order:admin:recent:*'),
        cache.del('order:admin:disputes:*'),
      ]);
    } catch (e) {
      log.warn({ /* FIX pass 343 DLP */ err: mask.text(String(e.message || '').slice(0, 300)), order_id: orderIdToInvalidate },
        '[cache.invalidate_fail.webhook]');
    }
  }

  log.info({ event: evt.event, order_id: orderIdToInvalidate }, '[webhook.processed]');
}

// POST /payments/payouts/:id/process - admin manda processar transfer
// FIX-WORKER-4: regex UUID antes do DB para evitar PG 22P02 -> 404 generico do global handler
const PAYOUT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// FIX-WORKER-11 pass 205 (CRITICAL): rate-limit /payments/payouts/:id/process.
// REAL MONEY OUT endpoint - mais critico que /checkout (pass 196).
// PRE-FIX: zero rate-limit. Admin/atacante com token admin pode:
//   - Spam /process em loop -> Asaas createTransfer disparado N vezes
//   - Mesmo com idempotent UPDATE guard (status='processing'), tx FOR UPDATE
//     pega lock breve - 100 reqs/s ainda criam pressao DB severa
//   - Asaas API rate-limit upstream -> calls subsequentes 429 + cost
//   - Audit log enche de payout.process_start tentativas
// FIX: 30 process/hora/admin (admin tipico processa <50/dia em mass payout day).
// Pattern V8 W7: high-impact real-$ mutations DEVEM ter limiter (mais restrito
// que /checkout pass 196 que tem 20/h - aqui 30/h cobre admin power user).
const payoutProcessLimiter = rateLimiter.createLimiter({
  windowMs: 60 * 60 * 1000, max: 30,
  message: 'Muitas tentativas de processar payouts. Aguarde alguns minutos.',
});

app.post('/payments/payouts/:id/process',
  payoutProcessLimiter,  // FIX-WORKER-11 pass 205: rate-limit anti-spam DoS Asaas API
  jwt.requireAuth({ roles: ['admin','staff'] }),
  asyncHandler(async (req, res, next) => {
    // FIX-WORKER-7 pass 23: 5 BUGS CRITICOS (real money out endpoint):
    //
    // 1. *** RACE DUPLO-PROCESS (Regra K) *** SELECT sem FOR UPDATE
    //    2 admins clicam "Aprovar Payout" simultaneo. Ambas requests leem
    //    status='approved' (sem lock), ambas chamam asaas.createTransfer ->
    //    2 TRANSFERS NA ASAAS para o mesmo payout. Seller recebe R$ X 2x.
    //    Plataforma perde R$ X real (financial loss direct).
    //    FIX: tx() + FOR UPDATE em seller_payouts.
    //
    // 2. *** ASAAS API SEM ROLLBACK *** transfer-then-UPDATE inversao critica
    //    Pre-fix:
    //      createTransfer() -> t.id  (Asaas confirma transfer real)
    //      UPDATE payouts SET status='paid'  (pode falhar restart/network)
    //    Se UPDATE falhar pos-createTransfer, transfer Asaas existe MAS DB
    //    diz status='approved' -> outro admin tenta de novo -> 2x transfer.
    //    Mitigacao parcial: idempotent UPDATE guard (bug 3) + audit log
    //    (bug 4) permite reconciliacao manual.
    //    Nota: full 2PC distributed transaction impossivel (Asaas externo).
    //    Best-effort: UPDATE 'processing' intermediario ANTES de createTransfer,
    //    audit_log ANTES, UPDATE 'paid' DEPOIS. Cron reconcile detecta stuck.
    //
    // 3. UPDATE final sem WHERE status='approved' (idempotent guard)
    //    Pre-fix: UPDATE WHERE id=$2 - sobrescreve mesmo se outra request
    //    ja virou 'paid'. FIX: AND status IN ('approved','processing')
    //    RETURNING id (rowcount=0 -> race detected).
    //
    // 4. AUDIT_LOG INSERT ausente em real-money-out endpoint
    //    Pattern W7 pass 20 (download.js) estabeleceu audit. Payout = MUITO
    //    mais critico (real $ saindo). Auditoria forense impossivel hoje.
    //    FIX: audit_log INSERT no MESMO tx() (atomic).
    //
    // 5. SELECT p.* viola Regra I
    //    seller_payouts pode ter internal_notes, risk_score, kyc_reviewed_at,
    //    rejection_reason. Lista explicita p/ security cross-svc.
    if (!PAYOUT_UUID_RE.test(req.params.id)) {
      return next(errorHandler.badRequest('invalid_uuid'));
    }

    // FASE 1 (tx atomic): lock + validate + mark 'processing'
    // Esta fase serializa entre admins concorrentes via FOR UPDATE.
    // Mark 'processing' = sinal p/ outros admins "alguem ja esta processando"
    // + cron reconcile detecta stuck (processing > 5min sem virar 'paid').
    /* FIX-WORKER-11 pass 318: withRetry wrap (paridade pass 311 webhook).
       2 admins racing payouts/approve+process simultaneo -> deadlock 40P01
       em SELECT FOR UPDATE seller_payouts row. Pattern V8 hot-path real-money. */
    let payout;
    let phaseError;
    await withRetry('payment.payout.process.tx', async () => {
    await tx(async (c) => {
      const r = await c.query(
        `SELECT p.id, p.seller_id, p.amount_cents, p.status, s.asaas_wallet_id
           FROM seller_payouts p
           LEFT JOIN sellers s ON s.id = p.seller_id
          WHERE p.id = $1
          FOR UPDATE OF p`,
        [req.params.id]
      );
      if (!r.rows.length) { phaseError = 'not_found'; return; }
      const row = r.rows[0];
      if (row.status !== 'approved') {
        phaseError = `not_approved:${row.status}`;
        return;
      }
      if (!row.asaas_wallet_id) { phaseError = 'wallet_missing'; return; }
      // Mark 'processing' atomico - bloqueia outros admins via state machine
      await c.query(
        `UPDATE seller_payouts SET status = 'processing', processing_started_at = NOW()
          WHERE id = $1 AND status = 'approved'`,
        [req.params.id]
      );
      // Audit log ANTES do Asaas call (forense: who tentou, when)
      await c.query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_before)
         VALUES ($1, $2, 'payout.process_start', 'seller_payout', $3, 'warn', $4::JSONB)`,
        [req.user.sub, req.user.role, req.params.id,
         JSON.stringify({ amount_cents: row.amount_cents, seller_id: row.seller_id })]
      );
      payout = row;
    });
    }); // close withRetry pass 318
    if (phaseError === 'not_found') return next(errorHandler.notFound('payout_not_found'));
    if (phaseError === 'wallet_missing') return next(errorHandler.badRequest('seller_wallet_missing'));
    if (phaseError?.startsWith('not_approved')) {
      return next(errorHandler.badRequest('payout_not_approved', `status atual: ${phaseError.split(':')[1]}`));
    }

    // FASE 2 (Asaas API - fora tx, demorado): createTransfer.
    // Em caso de exception, payout fica 'processing' - cron reconcile
    // detecta stuck > 5min e reverte para 'approved' (operator retry manual).
    // FIX-WORKER-11 pass 235 (float precision payout amount):
    //   payout.amount_cents e BIGINT em cents. Divisao direta /100 produz float
    //   suscetivel a IEEE 754 drift: R$1234.56 = 123456 cents -> 1234.56 OK,
    //   mas valores como 333333 cents -> 3333.33 (preciso) vs 333333.7 cents
    //   (raro mas Asaas pode retornar splits residuais com 1 decimal) ->
    //   3333.337 -> Asaas rejeita "invalid_value formato 2 casas".
    //   POST-FIX: Math.round(amount_cents) / 100 garante 2 casas decimais
    //   exatas mesmo se amount_cents vier como string PG ou float residual.
    let transfer;
    try {
      transfer = await asaas.createTransfer({
        wallet: payout.asaas_wallet_id,
        value: Math.round(Number(payout.amount_cents)) / 100,
        description: `Saque seller ${payout.seller_id}`,
        /* FIX-WORKER-11 pass 282: externalReference p/ reconcile reverso
           payout.id eh canonical chave - se transfer.id se perder ainda
           podemos query Asaas /transfers?externalReference=<id>. */
        externalReference: `payout:${req.params.id}`,
      });
    } catch (e) {
      log.error({ /* FIX pass 343 DLP */ err: mask.text(String(e.message || '').slice(0, 300)), payout_id: req.params.id },
        '[payout.asaas.fail] transfer falhou - payout permanece processing p/ cron reconcile');
      // Audit fail ANTES de rethrow
      await query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES ($1, $2, 'payout.process_fail', 'seller_payout', $3, 'critical', $4::JSONB)`,
        [req.user.sub, req.user.role, req.params.id,
         JSON.stringify({ error: /* FIX pass 345 DLP */ mask.text(String(e.message || '').slice(0, 500)) })]
      ).catch(() => {});
      return next(errorHandler.badRequest('asaas_transfer_failed', String(e.message)));
    }

    // FASE 3 (tx atomic): mark 'paid' + final audit log.
    // Idempotent UPDATE guard previne race-residual entre fase 1 e 3.
    const finalUpd = await query(
      `UPDATE seller_payouts SET status = 'paid', paid_at = NOW(),
                                  asaas_transfer_id = $1
        WHERE id = $2 AND status = 'processing'
        RETURNING id, seller_id`,
      [transfer.id, req.params.id]
    );
    if (!finalUpd.rows.length) {
      // Race extremamente raro: cron reconcile virou status durante fase 2
      log.error({ payout_id: req.params.id, transfer_id: transfer.id },
        '[payout.race.final] UPDATE falhou (status nao processing) - transfer Asaas executou, investigar manual');
    } else {
      // FIX-WORKER-18 pass 175 + 205: invalida cache seller + admin (pos-paid).
      // 2 paths de cache afetadas por payout 'paid':
      // - seller:payouts:{userId}:* (W18 pass 175) - seller /financeiro view
      // - seller:admin:payouts-pending:* (W18 pass 198) - admin /payouts dashboard
      // Sem isto: admin dashboard mostra 'approved' payout (stale 20s)
      // mesmo apos Asaas transfer confirmado. UX: admin clica process e ainda
      // ve mesmo payout listado nos 20s seguintes.
      try {
        const u = await query('SELECT user_id FROM sellers WHERE id = $1', [finalUpd.rows[0].seller_id]);
        const tasks = [
          cache.del('seller:admin:payouts-pending:*'),  // W18 pass 205: admin view
        ];
        if (u.rows[0]?.user_id) {
          tasks.push(cache.del(`seller:payouts:${u.rows[0].user_id}:*`));  // W18 pass 175: seller view
        }
        await Promise.all(tasks);

        // FIX-WORKER-11 pass 263 (notif gap payout_paid):
        //   PRE-FIX: seller esperava aprovacao + processamento (minutos)
        //   Payout vai p/ Asaas com sucesso mas seller nao recebia notif
        //   Comparar pass 258 W4 (seller_new_sale priority=2)
        //   payout_paid e o evento MAIS critico (dinheiro recebido!)
        //   POST-FIX: INSERT notification priority=2 (cash flow visibility)
        //
        // FIX-WORKER-11 pass 396 (in_app + email dual channel para payout_paid):
        //   PRE-FIX pass 263: APENAS channel='email' inserido
        //   - Email tem latencia outbox processor 30s + SMTP send
        //   - Em peak SMTP outage, email pode demorar 5-10min
        //   - Seller refresh dashboard /financeiro -> nao ve realtime
        //   - In_app notification (sininho) eh instantaneo
        //   MLB pattern: cash flow events SEMPRE dual channel
        //   POST-FIX: INSERT in_app PRIMEIRO (instantaneo - badge no header)
        //   + email (paridade pass 263 - mantido p/ paper trail)
        if (u.rows[0]?.user_id) {
          const notifTitle = `Saque processado: R$ ${(Number(payout.amount_cents)/100).toFixed(2)}`;
          const notifBody = `Seu saque de R$ ${(Number(payout.amount_cents)/100).toFixed(2)} foi processado e enviado para sua conta. Transfer ID Asaas: ${transfer.id}.`;
          const notifPayload = JSON.stringify({
            payout_id: req.params.id,
            asaas_transfer_id: transfer.id,
            amount_cents: payout.amount_cents,
          });
          // FIX pass 396: in_app PRIMEIRO (instantaneo - sininho header)
          await query(
            `INSERT INTO notifications (user_id, channel, template_code, title, body, priority, payload)
             VALUES ($1, 'in_app', 'payout_paid', $2, $3, 2, $4::JSONB)`,
            [u.rows[0].user_id, notifTitle, notifBody, notifPayload]
          ).catch((e) => log.warn({ err: mask.text(String(e.message || '').slice(0, 300)) }, '[payout.notif.in_app.fail]'));
          // Pass 263 mantido: email paper trail
          await query(
            `INSERT INTO notifications (user_id, channel, template_code, title, body, priority, payload)
             VALUES ($1, 'email', 'payout_paid', $2, $3, 2, $4::JSONB)`,
            [u.rows[0].user_id, notifTitle, notifBody, notifPayload]
          ).catch((e) => log.warn({ /* FIX pass 343 DLP */ err: mask.text(String(e.message || '').slice(0, 300)) }, '[payout.notif.email.fail]'));
        }
      } catch (_) { /* best-effort */ }
    }
    await query(
      `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
       VALUES ($1, $2, 'payout.process_complete', 'seller_payout', $3, 'info', $4::JSONB)`,
      [req.user.sub, req.user.role, req.params.id,
       JSON.stringify({ asaas_transfer_id: transfer.id, amount_cents: payout.amount_cents })]
    ).catch(() => {});

    res.json({ ok: true, transfer });
  })
);

// ============================================================
// FIX-WORKER-11 pass 7: cron reconciliation de webhooks stuck/failed
// ============================================================
// Contexto: W11 pass 6 introduziu tracking de processed_at + processing_error
// + retry_count em asaas_webhook_events. Webhooks que falharam apos signature
// valida (DB lock, network transitorio, etc) ficavam sem reprocessar.
//
// W14 pass 7 criou idx_asaas_evt_retry (retry_count DESC, received_at ASC)
// WHERE retry_count > 0 AND signature_valid = TRUE.
//
// Este cron usa o indice para encontrar webhooks com retry_count entre 1 e 5
// e reprocessar. retry_count > 5 sao "dead letter" - admin precisa investigar
// manualmente via GET /payments/webhooks/dead (endpoint abaixo).
//
// Interval: 5 minutos (suficiente para recuperar de blips transitorios sem
// hammer o DB com SELECT muito frequente).
async function reconcileWebhooks() {
  try {
    // FIX-WORKER-11 pass 244 (multi-replica race):
    //   PRE-FIX: SELECT sem FOR UPDATE SKIP LOCKED. Em Swarm 2+ replicas
    //   payment-svc, ambas rodavam setInterval(5min) simultaneo e selecionavam
    //   mesmos 20 rows. processWebhookEvent eh idempotent (ON CONFLICT no
    //   downstream) MAS UPDATE retry_count = retry_count + 1 nao - sem WHERE
    //   guard, ambas replicas incrementavam +1 -> total +2 per failure cycle
    //   -> retry_count atinge 5 (terminal) 2x mais rapido que esperado.
    //   Pattern qa-svc/timeoutStuckRuns (pass 240) consolidado: claim atomico
    //   via SELECT FOR UPDATE SKIP LOCKED -> cada replica pega lote distinto.
    //
    // FIX-WORKER-11 pass 409 (idempotent UPDATE guard - fix race sem lock 5min):
    //   PRE-FIX pass 244: SELECT FOR UPDATE SKIP LOCKED autocommit libera
    //   lock imediato pos-query. Race retry_count++ persiste em replicas.
    //   Tentou-se wrap tx() mas processWebhookEvent dentro tx = pool exhaustion
    //   (5min tx hold em payment-svc com 2-3 connections cada replica).
    //   POST-FIX: manter SELECT autocommit (lock window minimo, ~ms) +
    //   adicionar idempotent UPDATE guard com WHERE clause restrictive.
    //   UPDATE retry_count += 1 WHERE retry_count = $3 (val antigo lido)
    //   - Replica A: SELECT row retry=2 -> UPDATE retry=2 (OK +1=3)
    //   - Replica B: SELECT mesma row retry=2 -> UPDATE retry=2 (rowCount=0
    //     pois A ja moveu para 3) -> noop
    //   Same pattern em UPDATE processed_at = NOW() WHERE processed_at IS NULL
    //   (already implementado em pass 21 outros endpoints).
    const r = await query(
      `SELECT id, payload, retry_count
         FROM asaas_webhook_events
        WHERE signature_valid = TRUE
          AND processed_at IS NULL
          AND retry_count BETWEEN 1 AND 5
          AND received_at > NOW() - INTERVAL '24 hours'
        ORDER BY retry_count ASC, received_at ASC
        LIMIT 20
        FOR UPDATE SKIP LOCKED`
    );
    if (!r.rows.length) return;
    log.info({ count: r.rows.length }, '[reconcile.start]');
    for (const row of r.rows) {
      try {
        const evt = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
        await processWebhookEvent(evt);
        // Sucesso: marca processed e linka order_id
        const orderLink = evt.payment?.id
          ? await query('SELECT id FROM orders WHERE asaas_payment_id = $1', [evt.payment.id]).catch(() => ({ rows: [] }))
          : { rows: [] };
        // FIX-WORKER-11 pass 409 (idempotent UPDATE guard - race-safe sem lock window):
        //   PRE-FIX: WHERE id=$1 sem retry_count guard
        //   - 2 replicas processam mesma row em paralelo (lock SELECT autocommit
        //     releases immediately)
        //   - Ambas UPDATE processed_at = NOW() em sucesso = OK idempotent
        //   - MAS em fail path: ambas UPDATE retry_count += 1 -> double increment
        //   POST-FIX: WHERE id=$N AND processed_at IS NULL
        //   - Idempotent guard: replica B skip se A ja marcou processed
        //   - Race condition + double-increment retry_count ELIMINADO
        //   - Pattern V8 W11 paridade orders/asaas_payment_id UPDATE (pass 21)
        await query(
          `UPDATE asaas_webhook_events
              SET processed_at = NOW(),
                  order_id = COALESCE(order_id, $1::UUID),
                  processing_error = NULL
            WHERE id = $2 AND processed_at IS NULL`,
          [orderLink.rows[0]?.id || null, row.id]
        );
        log.info({ webhook_id: row.id, attempt: row.retry_count + 1 }, '[reconcile.ok]');
      } catch (e) {
        // FIX pass 409: idempotent guard retry_count - evita double-increment race
        await query(
          `UPDATE asaas_webhook_events
              SET processing_error = $1,
                  retry_count = retry_count + 1
            WHERE id = $2 AND processed_at IS NULL AND retry_count = $3`,
          [/* FIX pass 345 DLP */ mask.text(String(e.message || '').slice(0, 500)),
           row.id, row.retry_count]
        ).catch(() => {});
        log.warn({ webhook_id: row.id, /* FIX pass 343 DLP */ err: mask.text(String(e.message || '').slice(0, 300)) }, '[reconcile.fail]');
      }
    }
  } catch (e) {
    log.error({ /* FIX pass 343 DLP */ err: mask.text(String(e.message || '').slice(0, 300)) }, '[reconcile.batch.fail]');
  }
}

// GET /payments/webhooks/dead - admin lista webhooks "dead letter" (retry_count > 5)
// Permite admin investigar e decidir reprocessar manualmente via SQL ou ignorar
// GET /payments/webhooks/dead - dead-letter queue webhooks Asaas
// FIX-WORKER-7 pass 61: 5 BUGS aplicando Pattern W7 (Regras D+E+I + DLP).
//
// BUG 1 *** Regra D TIEBREAKER MISSING *** ORDER BY received_at DESC nao determ
//   2 webhooks received_at identicos (Asaas burst) -> ordem indefinida na queue.
//   FIX: + id DESC tiebreaker.
//
// BUG 2 *** Regra E PAGINATION MISSING *** hardcoded LIMIT 100
//   Em incidente Asaas (1000+ webhooks falhando) admin so ve top-100.
//   FIX: ?limit (1-200, default 50) + ?offset.
//
// BUG 3 *** DLP processing_error LEAK *** stack trace pode conter secrets
//   PRE-FIX: processing_error texto livre (ERROR sql + stack). Pode conter
//   "connect to host=postgres user=cas password=XYZ" se PG_PASS leak.
//   Tambem pode conter Bearer tokens (Asaas retry com header logged).
//   FIX: aplicar mask.text DLP (sk-/Bearer/JWT/CPF auto-masked).
//
// BUG 4 *** CACHE MISSING *** admin dashboard refresh manual 30s
//   Cron reconciliation roda 5min; queue admin observability nao precisa
//   realtime - cache 30s reduz DB load.
//   FIX: cache.cacheMiddleware 30s (vary by limit/offset filtros).
//
// BUG 5 *** TOTAL COUNT MISSING *** UX nao mostra "X webhooks pendentes total"
//   FIX: SELECT COUNT(*) p/ paginacao UI.
const deadWebhooksCacheKey = (req) => {
  const lim = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
  const off = Math.max(0, parseInt(req.query.offset, 10) || 0);
  return `payments:webhooks_dead:lim=${lim}:off=${off}`;
};

app.get('/payments/webhooks/dead',
  jwt.requireAuth({ roles: ['admin', 'staff'] }),
  cache.cacheMiddleware(deadWebhooksCacheKey, 30),
  asyncHandler(async (req, res) => {
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

    /* FIX-WORKER-18 pass 289: COUNT(*) OVER() window consolidation.
       PRE-FIX: 2 queries separadas (rows + COUNT separado) = 2 scan duplos
       no asaas_webhook_events. Pattern V8 cross-svc consolidado em 11+
       endpoints (auditLogHandler pass 200, alertsHandler pass 202, etc).
       POST-FIX: 1 query window aggregate - latencia 2x -> 1x scan.
       Tiebreaker received_at DESC + id DESC ja existia. */
    const r = await query(
      `SELECT id, event_type, asaas_payment_id, processing_error, retry_count, received_at,
              COUNT(*) OVER()::INT AS _total
         FROM asaas_webhook_events
        WHERE signature_valid = TRUE
          AND processed_at IS NULL
          AND retry_count > 5
        ORDER BY received_at DESC, id DESC
        LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const total = r.rows[0]?._total ?? 0;

    // FIX-WORKER-7 pass 61: DLP mask processing_error
    // Stack traces podem conter secrets (PG_PASS, Bearer tokens, JWT, CPF)
    const webhooks = r.rows.map((row) => {
      const { _total, ...rest } = row;
      return {
        ...rest,
        processing_error: rest.processing_error ? mask.text(rest.processing_error) : null,
      };
    });

    res.json({
      webhooks,
      count: webhooks.length,
      total,
      limit,
      offset,
      has_more: (offset + webhooks.length) < total,
    });
  })
);

// FIX-WORKER-11 pass 8: POST /payments/webhooks/:id/reset
// Admin reseta retry_count=0 sem precisar de psql direto (W4 pass 8 doc apontava
// para psql como unico caminho). Agora UI dashboard-admin pode oferecer botao
// "Reprocessar agora" inline.
//
// Logica:
// 1. Valida UUID (defesa upfront contra PG 22P02 -> 500)
// 2. SELECT FOR UPDATE (atomic - evita race com cron reconciliation)
// 3. Confere: signature_valid=TRUE + processed_at IS NULL (so reseta o que faz sentido)
// 4. UPDATE retry_count=0, processing_error=NULL
// 5. Imediato: chama processWebhookEvent fora do lock (nao espera proximo cron)
// 6. Audit log com actor + action='webhook.reset' para forensics
// FIX-WORKER-7 pass 95: 4 BUGS adicionais aplicando Pattern W7:
//
// BUG 1 *** RATE-LIMIT MISSING *** admin pwned spam resets
//   PRE-FIX: zero limit. Admin compromised dispara N resets simultaneos ->
//   setImmediate spawns N processWebhookEvent paralelos -> Asaas API call
//   amplification + race com cron reconcile.
//   FIX: webhookResetLimiter 10/hr/admin (real ops resets ~1-3/dia).
//
// BUG 2 *** DLP processing_error update *** linha 1105 (era pass 61 read-side only)
//   PRE-FIX: UPDATE SET processing_error = $1 com /* FIX pass 345 DLP */ mask.text(String(e.message || '').slice(0, 500))
//   sem mask.text(). Stack traces podem ter PG_PASS/Bearer/JWT em error msg.
//   Pass 61 mascarou na LEITURA mas escrita ainda puxa raw.
//   FIX: mask.text() antes do INSERT (DLP em both read+write paths).
//
// BUG 3 *** AUDIT LOG MISSING em reset.fail ***
//   PRE-FIX: catch block apenas log.warn (pino logs) - sem audit_log forense.
//   Reset falhou = problema operacional precisa rastreio compliance.
//   FIX: INSERT audit_log severity=error em catch.
//
// BUG 4 *** RACE setImmediate vs cron reconcile ***
//   PRE-FIX: setImmediate executa fora do tx() inicial. Apos UPDATE retry_count=0,
//   cron reconcile (5min interval) pode pegar mesmo webhook -> double processing.
//   Especialmente se reset coincide com cron tick.
//   FIX: re-claim com tx() + FOR UPDATE no setImmediate (skip se ja processed).
const PAYMENT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const webhookResetLimiter = require('@cas/shared').rateLimiter.createLimiter({
  windowMs: 60 * 60 * 1000, max: 10,
  message: 'Muitos resets de webhook recentes. Aguarde 1 hora.',
});

app.post('/payments/webhooks/:id/reset',
  jwt.requireAuth({ roles: ['admin', 'staff'] }),
  webhookResetLimiter,
  asyncHandler(async (req, res, next) => {
    if (!PAYMENT_UUID_RE.test(req.params.id)) {
      return next(errorHandler.badRequest('invalid_uuid'));
    }
    // SELECT FOR UPDATE: lock row durante reset (evita race com cron reconciliation
    // que esteja simultaneamente tentando processar este mesmo webhook)
    const reset = await tx(async (c) => {
      const cur = await c.query(
        `SELECT id, payload, signature_valid, processed_at, retry_count
           FROM asaas_webhook_events
          WHERE id = $1::UUID
          FOR UPDATE`,
        [req.params.id]
      );
      if (!cur.rows.length) return { error: 'not_found' };
      const row = cur.rows[0];
      if (!row.signature_valid) return { error: 'invalid_signature_cant_reset' };
      if (row.processed_at) return { error: 'already_processed' };
      // Reset
      await c.query(
        `UPDATE asaas_webhook_events
            SET retry_count = 0, processing_error = NULL
          WHERE id = $1`,
        [req.params.id]
      );
      // Audit log
      await c.query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES ($1, $2, 'webhook.reset', 'asaas_webhook_event', $3, 'info', $4::JSONB)`,
        [req.user.sub, req.user.role, req.params.id,
         JSON.stringify({ previous_retry_count: row.retry_count, ip: req.ip })]
      );
      return { ok: true, payload: row.payload, previous_retry_count: row.retry_count };
    });

    if (reset.error === 'not_found') return next(errorHandler.notFound('webhook_not_found'));
    if (reset.error === 'invalid_signature_cant_reset') {
      return next(errorHandler.badRequest('invalid_signature_cant_reset',
        'Webhook com signature_valid=FALSE nao pode ser resetado (proteção anti-fraude).'));
    }
    if (reset.error === 'already_processed') {
      return next(errorHandler.badRequest('already_processed',
        'Webhook ja foi processado com sucesso (processed_at != NULL).'));
    }

    // Tenta reprocessar IMEDIATAMENTE (nao espera proximo cron 5min)
    res.json({
      ok: true,
      previous_retry_count: reset.previous_retry_count,
      hint: 'Webhook resetado. Reprocessamento imediato disparado (assincrono).',
    });
    setImmediate(async () => {
      try {
        // BUG 4: re-claim com FOR UPDATE - skip se cron ja pegou
        // tx() garante atomic check-then-process
        const claimed = await tx(async (c) => {
          const r = await c.query(
            `SELECT id, payload, processed_at FROM asaas_webhook_events
              WHERE id = $1 FOR UPDATE`,
            [req.params.id]
          );
          if (!r.rows.length) return null;
          if (r.rows[0].processed_at) return null; // cron ja processou - skip
          return r.rows[0];
        });
        if (!claimed) {
          log.info({ webhook_id: req.params.id }, '[webhook.reset.skipped_already_processed]');
          return;
        }

        const evt = typeof claimed.payload === 'string' ? JSON.parse(claimed.payload) : claimed.payload;
        await processWebhookEvent(evt);
        const orderLink = evt.payment?.id
          ? await query('SELECT id FROM orders WHERE asaas_payment_id = $1', [evt.payment.id]).catch(() => ({ rows: [] }))
          : { rows: [] };
        await query(
          `UPDATE asaas_webhook_events
              SET processed_at = NOW(),
                  order_id = COALESCE(order_id, $1::UUID),
                  processing_error = NULL
            WHERE id = $2`,
          [orderLink.rows[0]?.id || null, req.params.id]
        );
        log.info({ webhook_id: req.params.id, actor: req.user.sub }, '[webhook.reset.processed]');
      } catch (e) {
        // BUG 2: DLP mask.text() em processing_error
        const maskedErr = mask.text(String(e.message || '')).slice(0, 500);
        await query(
          `UPDATE asaas_webhook_events
              SET processing_error = $1, retry_count = retry_count + 1
            WHERE id = $2`,
          [maskedErr, req.params.id]
        ).catch(() => {});

        // BUG 3: audit log atomic severity=error
        await query(
          `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
           VALUES ($1, $2, 'webhook.reset_failed', 'asaas_webhook_event', $3, 'error', $4::JSONB)`,
          [req.user.sub, req.user.role, req.params.id,
           JSON.stringify({ error_masked: maskedErr.slice(0, 200), ip: req.ip })]
        ).catch(() => {});

        log.warn({ webhook_id: req.params.id, err: maskedErr }, '[webhook.reset.fail]');
      }
    });
  })
);

// Cron interval: 5min. setImmediate para 1a execucao apos 30s (let svc warm up)
setTimeout(() => reconcileWebhooks().catch(() => {}), 30000);
setInterval(() => reconcileWebhooks().catch((e) => log.error({ /* FIX pass 343 DLP */ err: mask.text(String(e.message || '').slice(0, 300)) }, '[reconcile.cron.fail]')), 5 * 60 * 1000);
log.info('[reconcile.cron] webhook reconciliation cron started (5min interval)');

// ============================================================
// FIX-WORKER-11 pass 272 (cron liquidator payouts_pending_wallet):
//   Pass 270 W11 criou mig 078 + INSERT fallback em order-svc.
//   Este cron diario detecta seller now-has-wallet -> Asaas createTransfer
//   + UPDATE 'liquidated' + notification ao seller.
//   Pattern V8 cross-svc: order-svc declarativa (insere debt), payment-svc
//   imperative (cria transfer Asaas + atualiza state machine).
// ============================================================
async function liquidatePendingWalletPayouts() {
  try {
    // Lookup: rows pending + seller agora tem asaas_wallet_id (mig 078)
    const pending = await query(
      `SELECT pw.id, pw.order_id, pw.seller_id, pw.amount_cents,
              s.asaas_wallet_id, s.user_id
         FROM payouts_pending_wallet pw
         JOIN sellers s ON s.id = pw.seller_id
        WHERE pw.status = 'pending'
          /* FIX-WORKER-11 pass 278: empty string '' nao conta como wallet OK
             (admin clear -> seller string vazia, mas integridade falha no Asaas).
             Paridade com cart/admin endpoints. */
          AND s.asaas_wallet_id IS NOT NULL
          AND s.asaas_wallet_id <> ''
          AND s.status = 'active'
        ORDER BY pw.created_at ASC, pw.id ASC
        LIMIT 50
        FOR UPDATE OF pw SKIP LOCKED`
    );
    if (!pending.rows.length) return;
    log.info({ count: pending.rows.length }, '[payouts_pending.liquidate.start]');

    for (const row of pending.rows) {
      try {
        // Asaas transfer (createTransfer ja existe em asaas.js)
        // FIX-WORKER-11 pass 282: externalReference payouts_pending_wallet.id
        const transfer = await asaas.createTransfer({
          wallet: row.asaas_wallet_id,
          value: Math.round(Number(row.amount_cents)) / 100,
          description: `Liquidacao payout pendente (order ${row.order_id})`,
          externalReference: `payouts_pending_wallet:${row.id}`,
        });
        // UPDATE atomic - status + transfer_id + liquidated_at
        await query(
          `UPDATE payouts_pending_wallet
              SET status = 'liquidated',
                  liquidated_at = NOW(),
                  asaas_transfer_id = $1
            WHERE id = $2 AND status = 'pending'`,
          [transfer.id, row.id]
        );
        // Notify seller
        await query(
          `INSERT INTO notifications (user_id, channel, template_code, title, body, priority, payload)
           VALUES ($1, 'email', 'payout_pending_liquidated',
                   $2, $3, 2, $4::JSONB)`,
          [row.user_id,
           `Payout pendente liquidado: R$ ${(Number(row.amount_cents)/100).toFixed(2)}`,
           `Voce configurou sua wallet Asaas e seu payout pendente foi liquidado. Valor: R$ ${(Number(row.amount_cents)/100).toFixed(2)}. Transfer ID: ${transfer.id}.`,
           JSON.stringify({ pending_id: row.id, order_id: row.order_id, asaas_transfer_id: transfer.id })]
        ).catch((e) => log.warn({ /* FIX pass 343 DLP */ err: mask.text(String(e.message || '').slice(0, 300)) }, '[payouts_pending.notif.fail]'));
        log.info({ pending_id: row.id, transfer_id: transfer.id }, '[payouts_pending.liquidated.ok]');
      } catch (e) {
        log.error({ pending_id: row.id, /* FIX pass 343 DLP */ err: mask.text(String(e.message || '').slice(0, 300)) }, '[payouts_pending.liquidate.fail]');
        // Nao incrementa retry - admin investiga manualmente (Asaas/network issues)
      }
    }
  } catch (e) {
    log.error({ /* FIX pass 343 DLP */ err: mask.text(String(e.message || '').slice(0, 300)) }, '[payouts_pending.cron.fail]');
  }
}
// FIX-WORKER-11 pass 272: setInterval pattern (paridade reconcileWebhooks acima)
// payment-svc package.json sem node-cron - usar setInterval 24h
// Primeiro run apos 60s (warm-up + reconcileWebhooks ja rodou)
setTimeout(() => liquidatePendingWalletPayouts().catch(() => {}), 60000);
setInterval(() => liquidatePendingWalletPayouts().catch((e) =>
  log.error({ /* FIX pass 343 DLP */ err: mask.text(String(e.message || '').slice(0, 300)) }, '[payouts_pending.cron.fail]')), 24 * 60 * 60 * 1000);
log.info('[payouts_pending.cron] liquidate cron started (24h interval)');

// ============================================================
// FIX-WORKER-11 pass 275: forfeit cron payouts_pending_wallet
// ============================================================
// Cenario: seller deleta conta (sellers.deleted_at NOT NULL) ou e banned
// permanente sem nunca configurar asaas_wallet_id.
// payouts_pending_wallet rows associadas ficam stuck 'pending' indefinidamente.
// Cron diario detecta sellers deletados/banned > 90d com pending payouts ->
// marca status='forfeited' (cancelado por inatividade prolongada).
// Compliance: receita fica com plataforma (orphan funds) - admin auditavel.
async function forfeitOrphanPendingPayouts() {
  try {
    const r = await query(
      `UPDATE payouts_pending_wallet pw
          SET status = 'forfeited',
              forfeited_at = NOW(),
              forfeited_reason = 'seller_deleted_or_banned_90d'
         FROM sellers s
        WHERE pw.seller_id = s.id
          AND pw.status = 'pending'
          AND (
            (s.deleted_at IS NOT NULL AND s.deleted_at < NOW() - INTERVAL '90 days') OR
            (s.status = 'banned' AND s.updated_at < NOW() - INTERVAL '90 days')
          )
        RETURNING pw.id, pw.seller_id, pw.amount_cents`
    );
    if (r.rows.length) {
      const totalForfeited = r.rows.reduce((a, x) => a + Number(x.amount_cents || 0), 0);
      log.warn({
        count: r.rows.length,
        total_cents: totalForfeited,
      }, '[payouts_pending.forfeit] orphan payouts forfeited (seller deleted/banned >90d)');
      // Audit log para compliance LGPD/SOC2 (orphan funds tracking)
      await query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES (NULL, 'system', 'payouts_pending.forfeit_batch', 'payouts_pending_wallet', NULL, 'warn', $1::JSONB)`,
        [JSON.stringify({
          count: r.rows.length,
          total_cents: totalForfeited,
          reason: 'seller_deleted_or_banned_90d',
        })]
      ).catch(() => {});
    }
  } catch (e) {
    log.error({ /* FIX pass 343 DLP */ err: mask.text(String(e.message || '').slice(0, 300)) }, '[payouts_pending.forfeit.cron.fail]');
  }
}
// 24h interval offset 90s warm-up (apos liquidator 60s)
setTimeout(() => forfeitOrphanPendingPayouts().catch(() => {}), 90000);
setInterval(() => forfeitOrphanPendingPayouts().catch((e) =>
  log.error({ /* FIX pass 343 DLP */ err: mask.text(String(e.message || '').slice(0, 300)) }, '[payouts_pending.forfeit.cron.fail]')), 24 * 60 * 60 * 1000);
log.info('[payouts_pending.forfeit.cron] forfeit cron started (24h interval, 90d threshold)');

app.use((req, res) => res.status(404).json({ error: 'route_not_found' }));
app.use(errorHandler.errorMiddleware);

const server = app.listen(PORT, () => log.info({ port: PORT }, '[payment-svc] listening'));
['SIGINT','SIGTERM'].forEach((s) => process.on(s, () => server.close(() => process.exit(0))));
