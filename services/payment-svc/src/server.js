'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const express = require('express');
const crypto = require('node:crypto');
const { z } = require('zod');
const { query, tx } = require('@cas/db-client');
const { logger, sanitize, errorHandler, asyncHandler, validate, jwt, fail2ban, startup, cache } = require('@cas/shared');
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
  if (amount < 100) return res.json({ amount_cents: amount, installments: [] });
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
        [req.body.order_id, req.user.sub]
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

    // MLB-5: parcelamento (somente cartao) - calcula valor da parcela com a mesma politica do preview
    const inst = req.body.installment_count && order.payment_method === 'credit_card' ? req.body.installment_count : 1;
    let installmentValue;
    if (inst > 1) {
      const monthlyRate = 0.0299;
      const totalCentsForCalc = inst <= 3 ? order.total_cents : Math.round(order.total_cents * Math.pow(1 + monthlyRate, inst - 1));
      installmentValue = Math.floor(totalCentsForCalc / inst) / 100;
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

  // Idempotencia (so se tiver event_id)
  if (data.id) {
    const exists = await query('SELECT 1 FROM asaas_webhook_events WHERE asaas_event_id = $1', [data.id]);
    if (exists.rows.length) return res.json({ ok: true, duplicate: true });
  }

  // FIX-WORKER-11 pass 6: capturar event_row_id p/ poder atualizar processed_at/processing_error
  // depois do setImmediate. Antes: rows da tabela ficavam SEMPRE com processed_at=NULL
  // (campo presente no schema mas nunca populado). Auditoria/reconciliacao impossivel:
  // - SELECT * FROM asaas_webhook_events WHERE processed_at IS NULL = sempre TODOS
  // - SELECT * WHERE processing_error IS NOT NULL = sempre vazio (mesmo com fails)
  // - retry_count sempre 0 mesmo com webhooks reprocessados
  const insertResult = await query(
    `INSERT INTO asaas_webhook_events (event_type, asaas_event_id, asaas_payment_id, payload, signature_valid)
     VALUES ($1, $2, $3, $4::JSONB, $5)
     RETURNING id`,
    [data.event, data.id || null, data.payment?.id || null, JSON.stringify(data), valid]
  );
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
const ALLOWED_TRANSITIONS = {
  // From state: [to states permitidos]
  'pending':    ['authorized', 'captured', 'failed'],
  'authorized': ['captured', 'failed', 'refunded'],
  'captured':   ['refunded', 'failed'], // refund/chargeback validos
  'refunded':   [],                      // terminal - reprocessar = noop
  'failed':     ['authorized'],          // retry pos-failed eh OK
};

async function processWebhookEvent(evt) {
  const paymentId = evt.payment?.id;
  if (!paymentId) return;

  const map = {
    PAYMENT_RECEIVED:    { ps: 'captured', os: 'paid', paid_at: true },
    PAYMENT_CONFIRMED:   { ps: 'captured', os: 'paid', paid_at: true },
    PAYMENT_REFUNDED:    { ps: 'refunded', os: 'refunded' },
    PAYMENT_OVERDUE:     { ps: 'failed',   os: 'expired' },
    PAYMENT_DELETED:     { ps: 'failed',   os: 'cancelled' },
    PAYMENT_REFUND_FAILED:{ ps: 'failed' },
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
           VALUES ($1::UUID, $2::INT, 'order_refunded', 'order', $3::text)`,
          [tx.user_id, reversal, order.id]
        );
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
           VALUES ($1::UUID, $2::INT, 'order_refund_restore', 'order', $3::text)`,
          [refundRedeem.rows[0].buyer_user_id, pts, order.id]
        );
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
  log.info({ event: evt.event, order_id: order.id }, '[webhook.processed]');
}

// POST /payments/payouts/:id/process - admin manda processar transfer
// FIX-WORKER-4: regex UUID antes do DB para evitar PG 22P02 -> 404 generico do global handler
const PAYOUT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
app.post('/payments/payouts/:id/process',
  jwt.requireAuth({ roles: ['admin','staff'] }),
  asyncHandler(async (req, res, next) => {
    if (!PAYOUT_UUID_RE.test(req.params.id)) {
      return next(errorHandler.badRequest('invalid_uuid'));
    }
    // FIX-WORKER-4: distingue 'inexistente' de 'existe mas nao-aprovado'
    const exists = await query(`SELECT status FROM seller_payouts WHERE id = $1`, [req.params.id]);
    if (!exists.rows.length) return next(errorHandler.notFound('payout_not_found'));
    if (exists.rows[0].status !== 'approved') {
      return next(errorHandler.badRequest('payout_not_approved', `status atual: ${exists.rows[0].status}`));
    }
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
    const r = await query(
      `SELECT id, payload, retry_count
         FROM asaas_webhook_events
        WHERE signature_valid = TRUE
          AND processed_at IS NULL
          AND retry_count BETWEEN 1 AND 5
          AND received_at > NOW() - INTERVAL '24 hours'
        ORDER BY retry_count ASC, received_at ASC
        LIMIT 20`
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
app.get('/payments/webhooks/dead',
  jwt.requireAuth({ roles: ['admin', 'staff'] }),
  asyncHandler(async (req, res) => {
    const r = await query(
      `SELECT id, event_type, asaas_payment_id, processing_error, retry_count, received_at
         FROM asaas_webhook_events
        WHERE signature_valid = TRUE
          AND processed_at IS NULL
          AND retry_count > 5
        ORDER BY received_at DESC LIMIT 100`
    );
    res.json({ webhooks: r.rows, count: r.rows.length });
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
const PAYMENT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

app.post('/payments/webhooks/:id/reset',
  jwt.requireAuth({ roles: ['admin', 'staff'] }),
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
        const evt = typeof reset.payload === 'string' ? JSON.parse(reset.payload) : reset.payload;
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
        await query(
          `UPDATE asaas_webhook_events
              SET processing_error = $1, retry_count = retry_count + 1
            WHERE id = $2`,
          [String(e.message).slice(0, 500), req.params.id]
        ).catch(() => {});
        log.warn({ webhook_id: req.params.id, err: e.message }, '[webhook.reset.fail]');
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
