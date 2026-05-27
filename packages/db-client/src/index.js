'use strict';

const { Pool } = require('pg');
const { logger, withRetry } = require('@cas/shared');

const log = logger.child({ pkg: 'db-client' });

let _pool;

function getPool() {
  if (_pool) return _pool;
  // FIX-WORKER-10 pass 6: statement_timeout 10s default (configuravel via PG_STATEMENT_TIMEOUT_MS).
  // Sem isso, queries lentas/runaway podiam locker pool inteiro indefinidamente.
  // 10s e generoso para queries lentas legitimas (analytics) mas mata runaway loops/cartesianos.
  // Em prod com slow query log monitoring, alertar quando hit este teto.
  const statementTimeoutMs = parseInt(process.env.PG_STATEMENT_TIMEOUT_MS || '10000', 10);
  _pool = new Pool({
    host: process.env.PG_HOST || '127.0.0.1',
    port: parseInt(process.env.PG_PORT || '5432', 10),
    user: process.env.PG_USER || 'codeshop',
    password: process.env.PG_PASS || '',
    database: process.env.PG_DB || 'code_agent_shop',
    max: parseInt(process.env.PG_POOL_MAX || '20', 10),
    idleTimeoutMillis: parseInt(process.env.PG_POOL_IDLE_TIMEOUT || '30000', 10),
    connectionTimeoutMillis: 10000,
    application_name: process.env.APP_NAME || 'code-agent-shop',
    // PG-level timeout: query > 10s -> ERROR canceling statement due to statement timeout
    statement_timeout: statementTimeoutMs,
  });
  _pool.on('error', (err) => log.error({ err }, '[pg] idle client error'));
  _pool.on('connect', () => log.debug('[pg] new client connected'));
  return _pool;
}

/**
 * Query simples com withRetry automatico para deadlocks (40P01).
 */
async function query(text, params, opts = {}) {
  const pool = getPool();
  return withRetry(opts.opName || 'pg.query', async () => {
    const t0 = Date.now();
    const res = await pool.query(text, params);
    const dur = Date.now() - t0;
    if (dur > 1000) log.warn({ dur, sql: text.slice(0, 120) }, '[pg.slow]');
    return res;
  }, opts);
}

/**
 * Wrapper de transacao com BEGIN/COMMIT/ROLLBACK + retry deadlock
 */
async function tx(callback, opts = {}) {
  const pool = getPool();
  return withRetry(opts.opName || 'pg.tx', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await callback(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      throw e;
    } finally {
      client.release();
    }
  }, opts);
}

async function healthcheck() {
  try {
    const r = await query('SELECT 1 AS ok, NOW() AS ts');
    return { ok: true, ts: r.rows[0].ts };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function close() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

module.exports = { getPool, query, tx, healthcheck, close };
