'use strict';

const { logger, withRetry, mask } = require('@cas/shared');
const log = logger.child({ svc: 'payment-svc', mod: 'asaas' });

const BASE = process.env.ASAAS_API_URL || 'https://api.asaas.com/v3';
const KEY  = process.env.ASAAS_API_KEY;

async function api(method, path, body) {
  if (!KEY) throw new Error('ASAAS_API_KEY ausente');
  return withRetry(`asaas.${method}.${path}`, async () => {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', access_token: KEY, accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!r.ok) {
      /* FIX-WORKER-11 pass 306: DLP mask Asaas error response em logs.
         PRE-FIX: log.warn raw 'data' field. Asaas error responses ecoam o
         payload original com CPF/CNPJ + email + cardNumber prefix.
         Pino logs Pino-pretty + datadog dump objeto inteiro = PII leak.
         POST-FIX: mask.obj(data) recursive DLP mask antes log.
         err.data preservado raw para upstream caller decide format. */
      const safeData = data && typeof data === 'object' ? mask.obj(data) : data;
      log.warn({ method, path, status: r.status, data: safeData }, '[asaas.err]');
      const err = new Error(`asaas_${r.status}`);
      err.status = r.status;
      err.data = data;
      throw err;
    }
    return data;
  });
}

async function createCustomer({ name, cpfCnpj, email, phone, externalReference }) {
  return api('POST', '/customers', { name, cpfCnpj, email, phone, externalReference });
}

async function getCustomer(id) { return api('GET', `/customers/${id}`); }

// FIX-WORKER-11 pass 5: bug arredondamento em parcelamento com split.
// ANTES: em CREDIT_CARD installmentCount>1, codigo enviava SO installmentCount +
// installmentValue, OMITINDO value total. Asaas usa installmentValue*count para
// derivar o total, mas com floor() em linha 201 do server.js perdem-se centavos.
// Exemplo: total=R$1380.66 / 12x = R$115.055 -> floor(115.05) -> Asaas calcula
// 115.05*12=R$1380.60, gap de R$0.06. Split com fixedValue calculado sobre
// total_cents ORIGINAL (R$1380.66 numerico) excede installmentValue*count
// soma -> Asaas rejeita "invalid_value: split sum > total".
//
// FIX: enviar totalValue (campo aceito Asaas v3 docs) que tem precedencia
// sobre installmentValue*count. Asaas redistribui parcelas internamente
// (a ultima pode ter centavos extras) E split casa com total real.
// Quando sem split, comportamento equivalente ao anterior.
async function createPayment({ customer, billingType, value, dueDate, description, externalReference, split, installmentCount, installmentValue }) {
  const payload = {
    customer, billingType, dueDate, description, externalReference,
    split: split && split.length ? split : undefined,
  };
  // MLB-5: Mercado Credito - parcelamento em cartao
  if (billingType === 'CREDIT_CARD' && installmentCount && installmentCount > 1) {
    payload.installmentCount = installmentCount;
    payload.installmentValue = installmentValue || Math.round((value / installmentCount) * 100) / 100;
    // totalValue (canonical total no formato Asaas) garante que split casa
    // com cobranca real. Asaas redistribui internamente entre as parcelas.
    payload.totalValue = value;
  } else {
    payload.value = value;
  }
  return api('POST', '/payments', payload);
}

async function getPayment(id) { return api('GET', `/payments/${id}`); }

async function getPixQrCode(id) { return api('GET', `/payments/${id}/pixQrCode`); }

/* FIX-WORKER-11 pass 439 (defensive guard partial refund vs full):
   PRE-FIX: value ? { value, description } : { description }
   - value=0 -> falsy -> sends { description } -> Asaas trata FULL refund
   - value=NaN -> falsy -> idem (NaN tipico de Math.min com NaN input)
   - value=-5 -> truthy -> sends value:-5 -> Asaas 400 (invalid_value)
   - value='' -> falsy -> sends { description } -> Asaas FULL refund
   Cenario REAL MONEY LOSS:
   - order-svc dispute resolve passa refund_amount_cents=0 (admin slip)
   - server.js linha 452-454: refundValueBRL = 0/100 = 0
   - refundPayment(id, 0, reason) -> { description } -> FULL refund Asaas
   - Buyer recebe TOTAL em vez de R$0,00 = perda financeira sem trace
   POST-FIX: explicit check Number.isFinite(value) && value > 0.
   - 0 / NaN / negativos / strings sempre throws -> caller deve passar
     undefined p/ full refund explicito (intent clear).
   - Asaas v3 docs: value omitted = full refund, value present > 0 = partial. */
async function refundPayment(id, value, description) {
  if (value !== undefined && value !== null) {
    if (!Number.isFinite(value) || value <= 0) {
      const e = new Error(`refundPayment_invalid_value: ${value} (expect undefined p/ full refund OR finite > 0)`);
      e.transient = false;
      throw e;
    }
  }
  return api('POST', `/payments/${id}/refund`,
    (value !== undefined && value !== null) ? { value, description } : { description });
}

/* FIX-WORKER-11 pass 289 (BUG REAL MONEY LOSS - cancelPayment ausente):
   PRE-FIX: server.js linha 368 chama asaas.cancelPayment?.(payment.id) com
   optional chaining. cancelPayment NAO EXISTE em exports -> silently no-op.
   Cenario race condition: 2 requests createPayment simultaneo -> 2 Asaas
   payments criados -> apenas 1 vence UPDATE no DB. O outro Asaas payment
   permanece billable - user pode pagar 2 PIX/boletos para mesma order.
   POST-FIX: implementar cancelPayment via DELETE /payments/:id (Asaas v3 docs).
   Combina com upd.rows.length=0 path para evitar double-charge real. */
async function cancelPayment(id) {
  return api('DELETE', `/payments/${id}`);
}

/* FIX-WORKER-11 pass 282: externalReference em createTransfer
   PRE-FIX: transfer Asaas criado sem campo externalReference - reconciliacao
   pos-transfer (webhook TRANSFER_DONE ou status check manual) precisa lookup
   transfer.id em DB. Se transfer.id perdido (cron crash entre create+UPDATE),
   sem rastreio reverso eficiente.
   POST-FIX: aceita externalReference opcional (payout.id ou pw.id) - canonical
   chave reconcile cross-systems. Asaas v3 documenta o campo no /transfers. */
async function createTransfer({ wallet, value, description, externalReference }) {
  const payload = { walletId: wallet, value, description };
  if (externalReference) payload.externalReference = externalReference;
  return api('POST', '/transfers', payload);
}

module.exports = {
  createCustomer, getCustomer,
  createPayment, getPayment, getPixQrCode, refundPayment, cancelPayment,
  createTransfer,
};
