'use strict';

const logger = require('./logger').default;

/**
 * Self-healing para deadlocks Postgres 40P01 (V8 23.5).
 * Tambem retry em 40001 (serialization_failure) e 57P01 (admin_shutdown).
 */
const RETRYABLE_CODES = new Set(['40P01', '40001', '57P01', '57P03', 'ECONNRESET', 'ETIMEDOUT']);

async function withRetry(operationName, operationFn, opts = {}) {
  const maxRetries  = opts.maxRetries ?? 3;
  const baseDelay   = opts.baseDelay  ?? 500;
  const jitter      = opts.jitter     ?? 200;
  const onRetry     = opts.onRetry;
  let attempt = 0;
  let lastError;

  while (attempt < maxRetries) {
    try {
      return await operationFn();
    } catch (error) {
      lastError = error;
      const code = error.code || error.cause?.code;
      const isRetryable = RETRYABLE_CODES.has(code);
      if (!isRetryable) throw error;
      attempt++;
      if (attempt >= maxRetries) break;
      const delayMs = baseDelay * Math.pow(2, attempt) + Math.random() * jitter;
      logger.warn(
        { op: operationName, attempt, code, delayMs },
        `[withRetry] retry ${attempt}/${maxRetries}`
      );
      if (onRetry) onRetry({ attempt, error, delayMs });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(`[withRetry:${operationName}] esgotou ${maxRetries} tentativas. Ultimo erro: ${lastError?.message}`);
}

module.exports = withRetry;
module.exports.withRetry = withRetry;
module.exports.RETRYABLE_CODES = RETRYABLE_CODES;
