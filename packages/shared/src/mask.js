'use strict';

/**
 * Mascaramento DLP de secrets em logs (V8 4.4).
 */
const PATTERNS = [
  { name: 'openai',      regex: /sk-[a-zA-Z0-9_-]{20,}/g },
  { name: 'anthropic',   regex: /sk-ant-[a-zA-Z0-9_-]{20,}/g },
  { name: 'gemini',      regex: /AIza[a-zA-Z0-9_-]{30,}/g },
  { name: 'groq',        regex: /gsk_[a-zA-Z0-9_-]{30,}/g },
  { name: 'bearer',      regex: /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi },
  { name: 'jwt',         regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: 'cpf',         regex: /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g },
  { name: 'cnpj',        regex: /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g },
  { name: 'creditcard',  regex: /\b(?:\d[ -]*?){13,19}\b/g },
  { name: 'asaas_key',   regex: /\$aact_[A-Za-z0-9]{40,}/g },
];

function text(input) {
  if (process.env.LOG_MASK_SECRETS === 'false') return input;
  if (typeof input !== 'string') return input;
  let out = input;
  for (const p of PATTERNS) out = out.replace(p.regex, `[MASKED_${p.name.toUpperCase()}]`);
  return out;
}

function obj(input) {
  if (input == null) return input;
  if (typeof input === 'string') return text(input);
  if (Array.isArray(input)) return input.map(obj);
  if (typeof input === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(input)) o[k] = obj(v);
    return o;
  }
  return input;
}

function fingerprint(secret, prefix = 6) {
  if (!secret) return null;
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256').update(secret).digest('hex');
  return `${String(secret).slice(0, prefix)}...${hash.slice(0, 8)}`;
}

module.exports = { text, obj, fingerprint, PATTERNS };
