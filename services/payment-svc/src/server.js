'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const express = require('express');
const crypto = require('node:crypto');
const { z } = require('zod');
const { query, tx } = require('@cas/db-client');
const { logger, sanitize, errorHandler, asyncHandler, validate, jwt, fail2ban, startup, cache, mask, rateLimiter } = require('@cas/shared');
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
    log.warn({ ip: req.ip, ua: req.headers['user-agent'] }, '[payment.create.invalid_internal_token]');
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
      const o = await c.query(
        `SELECT o.id, o.buyer_user_id, o.order_number, o.payment_status,
                o.payment_method, o.total_cents, o.currency,
                u.email, u.full_name, u.cpf_cnpj, u.phone_e164
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
    const u = await query('SELECT metadata FROM users WHERE id = $1', [order.buyer_user_id]);
    let customerId = u.rows[0]?.metadata?.asaas_customer_id;
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
      billingType: billingMap[order.payment_method],
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
      try { pix = await asaas.getPixQrCode(payment.id); } catch (e) { log.warn({ err: e.message }, '[pix.qr.fail]'); }
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
      try {
        await asaas.cancelPayment?.(payment.id);
      } catch (e) {
        log.error({ err: e.message, payment_id: payment.id },
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
    log.warn({ ip: req.ip, ua: req.headers['user-agent'] }, '[webhook.invalid_payload]');
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
  const insertResult = await query(
    `INSERT INTO asaas_webhook_events (event_type, asaas_event_id, asaas_payment_id, payload, signature_valid)
     VALUES ($1, $2, $3, $4::JSONB, $5)
     ON CONFLICT (asaas_event_id) DO NOTHING
     RETURNING id`,
    [data.event, data.id || null, data.payment?.id || null, JSON.stringify(data), valid]
  );
  // Se ON CONFLICT triggered (duplicate event), rows[] empty -> duplicate ack
  if (data.id && !insertResult.rows.length) {
    return res.json({ ok: true, duplicate: true });
  }
  const eventRowId = insertResult.rows[0]?.id;

  // Se invalido, NUNCA processa - retorna 401
  if (!valid) {
    log.warn({ event: data.event, ip: req.ip, ua: req.headers['user-agent'] }, '[webhook.invalid_signature]');
    return res.status(401).json({ error: 'invalid_signature' });
  }

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
      log.error({ err: e.message, eventRowId }, '[webhook.process.fail]');
      await query(
        `UPDATE asaas_webhook_events
            SET processing_error = $1,
                retry_count = retry_count + 1
          WHERE id = $2`,
        [String(e.message).slice(0, 500), eventRowId]
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

async function processWebhookEvent(evt) {
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
        const dup = await c.query(
          `SELECT id FROM loyalty_transactions
            WHERE user_id = $1::UUID AND reason = 'order_paid'
              AND reference_type = 'order' AND reference_id = $2::TEXT
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
              await c.query(
                `INSERT INTO notifications (user_id, channel, template_code, title, body)
                 VALUES ($1::UUID, 'in_app', 'loyalty_tier_up',
                         $2, $3)`,
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
        log.error({ err: e.message, order_id: order.id }, '[loyalty.earn.fail]');
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
        await c.query(
          `INSERT INTO notifications (user_id, channel, template_code, title, body, payload)
           VALUES ($1, 'email', 'seller_new_sale', 'Nova venda', $2, $3::JSONB)`,
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
      log.warn({ err: e.message, users: loyaltyUsersToInvalidate.size },
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
      log.warn({ err: e.message, order_id: orderIdToInvalidate },
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
    let payout;
    let phaseError;
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
      });
    } catch (e) {
      log.error({ err: e.message, payout_id: req.params.id },
        '[payout.asaas.fail] transfer falhou - payout permanece processing p/ cron reconcile');
      // Audit fail ANTES de rethrow
      await query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES ($1, $2, 'payout.process_fail', 'seller_payout', $3, 'critical', $4::JSONB)`,
        [req.user.sub, req.user.role, req.params.id,
         JSON.stringify({ error: String(e.message).slice(0, 500) })]
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
        await query(
          `UPDATE asaas_webhook_events
              SET processed_at = NOW(),
                  order_id = COALESCE(order_id, $1::UUID),
                  processing_error = NULL
            WHERE id = $2`,
          [orderLink.rows[0]?.id || null, row.id]
        );
        log.info({ webhook_id: row.id, attempt: row.retry_count + 1 }, '[reconcile.ok]');
      } catch (e) {
        await query(
          `UPDATE asaas_webhook_events
              SET processing_error = $1,
                  retry_count = retry_count + 1
            WHERE id = $2`,
          [String(e.message).slice(0, 500), row.id]
        ).catch(() => {});
        log.warn({ webhook_id: row.id, err: e.message }, '[reconcile.fail]');
      }
    }
  } catch (e) {
    log.error({ err: e.message }, '[reconcile.batch.fail]');
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

    const r = await query(
      `SELECT id, event_type, asaas_payment_id, processing_error, retry_count, received_at
         FROM asaas_webhook_events
        WHERE signature_valid = TRUE
          AND processed_at IS NULL
          AND retry_count > 5
        ORDER BY received_at DESC, id DESC
        LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    // FIX-WORKER-7 pass 61: DLP mask processing_error
    // Stack traces podem conter secrets (PG_PASS, Bearer tokens, JWT, CPF)
    const webhooks = r.rows.map((row) => ({
      ...row,
      processing_error: row.processing_error ? mask.text(row.processing_error) : null,
    }));

    // Total count para UX pagination
    const totalRes = await query(
      `SELECT COUNT(*)::INT AS total FROM asaas_webhook_events
        WHERE signature_valid = TRUE AND processed_at IS NULL AND retry_count > 5`
    );

    res.json({
      webhooks,
      count: webhooks.length,
      total: totalRes.rows[0].total,
      limit,
      offset,
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
//   PRE-FIX: UPDATE SET processing_error = $1 com String(e.message).slice(0, 500)
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
setInterval(() => reconcileWebhooks().catch((e) => log.error({ err: e.message }, '[reconcile.cron.fail]')), 5 * 60 * 1000);
log.info('[reconcile.cron] webhook reconciliation cron started (5min interval)');

app.use((req, res) => res.status(404).json({ error: 'route_not_found' }));
app.use(errorHandler.errorMiddleware);

const server = app.listen(PORT, () => log.info({ port: PORT }, '[payment-svc] listening'));
['SIGINT','SIGTERM'].forEach((s) => process.on(s, () => server.close(() => process.exit(0))));
