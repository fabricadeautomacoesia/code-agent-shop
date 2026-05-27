'use strict';

const { logger, withRetry } = require('@cas/shared');
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
      log.warn({ method, path, status: r.status, data }, '[asaas.err]');
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

async function refundPayment(id, value, description) {
  return api('POST', `/payments/${id}/refund`, value ? { value, description } : { description });
}

async function createTransfer({ wallet, value, description }) {
  return api('POST', '/transfers', { walletId: wallet, value, description });
}

module.exports = {
  createCustomer, getCustomer,
  createPayment, getPayment, getPixQrCode, refundPayment,
  createTransfer,
};
