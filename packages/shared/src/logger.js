'use strict';

const pino = require('pino');
const mask = require('./mask');

/**
 * Logger estruturado pino com DLP de secrets (V8 4.4).
 * Cada modulo cria seu logger filho: const log = require('@cas/shared').logger.child({ svc: 'auth-svc' });
 */
const base = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: {
    env: process.env.NODE_ENV || 'development',
    pid: process.pid,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'password', '*.password',
      'password_hash', '*.password_hash',
      'token', '*.token',
      'accessToken', '*.accessToken',
      'refreshToken', '*.refreshToken',
      'authorization', 'headers.authorization',
      'cookie', 'headers.cookie',
      'apiKey', '*.apiKey', 'api_key', '*.api_key',
      'secret', '*.secret',
      'cpf', 'cpf_cnpj',
      'cardNumber', 'card_number',
      'cvv',
    ],
    censor: '[REDACTED]',
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  transport: process.env.NODE_ENV === 'production' ? undefined : {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', singleLine: false },
  },
});

/**
 * Wrapper que tambem mascara strings com sk-... ou Bearer ... dentro de payloads
 */
function withMask(obj) {
  if (typeof obj === 'string') return mask.text(obj);
  if (Array.isArray(obj)) return obj.map(withMask);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = withMask(v);
    return out;
  }
  return obj;
}

function child(bindings) {
  const l = base.child(bindings);
  return new Proxy(l, {
    get(target, prop) {
      if (['trace','debug','info','warn','error','fatal'].includes(prop)) {
        return (a, b) => {
          if (typeof a === 'object') return target[prop](withMask(a), b);
          return target[prop](a, typeof b === 'object' ? withMask(b) : b);
        };
      }
      if (prop === 'child') return (sub) => child({ ...bindings, ...sub });
      return target[prop];
    },
  });
}

module.exports = {
  base,
  child,
  default: child({ svc: 'app' }),
};
module.exports.info  = (...a) => module.exports.default.info(...a);
module.exports.warn  = (...a) => module.exports.default.warn(...a);
module.exports.error = (...a) => module.exports.default.error(...a);
module.exports.debug = (...a) => module.exports.default.debug(...a);
