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

async function createPayment({ customer, billingType, value, dueDate, description, externalReference, split }) {
  return api('POST', '/payments', {
    customer, billingType, value, dueDate, description, externalReference,
    split: split && split.length ? split : undefined,
  });
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
