#!/usr/bin/env node
'use strict';

/**
 * smoke-tests.js - verificacao basica de saude pos-deploy.
 * Cada servico deve responder /health com { ok: true } em ate 5s.
 */

require('dotenv').config();

const ENDPOINTS = [
  { name: 'gateway',          url: `http://127.0.0.1:${process.env.PORT_GATEWAY      || 3002}/api/status` },
  { name: 'auth-svc',         url: `http://127.0.0.1:${process.env.PORT_AUTH         || 3010}/health` },
  { name: 'vault-svc',        url: `http://127.0.0.1:${process.env.PORT_VAULT        || 3020}/health` },
  { name: 'seller-svc',       url: `http://127.0.0.1:${process.env.PORT_SELLER       || 3011}/health` },
  { name: 'product-svc',      url: `http://127.0.0.1:${process.env.PORT_PRODUCT      || 3012}/health` },
  { name: 'qa-svc',           url: `http://127.0.0.1:${process.env.PORT_QA           || 3013}/health` },
  { name: 'qa-worker',        url: `http://127.0.0.1:${process.env.PORT_QA_WORKER    || 3014}/health` },
  { name: 'order-svc',        url: `http://127.0.0.1:${process.env.PORT_ORDER        || 3015}/health` },
  { name: 'payment-svc',      url: `http://127.0.0.1:${process.env.PORT_PAYMENT      || 3016}/health` },
  { name: 'review-svc',       url: `http://127.0.0.1:${process.env.PORT_REVIEW       || 3017}/health` },
  { name: 'notification-svc', url: `http://127.0.0.1:${process.env.PORT_NOTIFICATION || 3018}/health` },
  { name: 'search-svc',       url: `http://127.0.0.1:${process.env.PORT_SEARCH       || 3019}/health` },
  { name: 'aiops-svc',        url: `http://127.0.0.1:${process.env.PORT_AIOPS        || 3006}/health` },
];

async function check(svc) {
  const t0 = Date.now();
  try {
    const r = await fetch(svc.url, { signal: AbortSignal.timeout(5000) });
    const json = await r.json();
    const dur = Date.now() - t0;
    return { ...svc, ok: r.ok && (json.ok !== false), status: r.status, dur, body: json };
  } catch (e) {
    return { ...svc, ok: false, status: 0, dur: Date.now() - t0, error: e.message };
  }
}

async function checkDb() {
  try {
    const { healthcheck, close } = require('@cas/db-client');
    const r = await healthcheck();
    await close();
    return { ok: r.ok, ts: r.ts, error: r.error };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

(async () => {
  console.log('\n=== Code & Agent Shop - Smoke Tests ===\n');

  // 1. DB
  console.log('[1/2] PostgreSQL...');
  const db = await checkDb();
  console.log(db.ok ? `  OK - ${db.ts}\n` : `  FAIL - ${db.error}\n`);

  // 2. Microservices
  console.log('[2/2] Microservicos:');
  const results = await Promise.all(ENDPOINTS.map(check));

  let okCount = 0, failCount = 0;
  for (const r of results) {
    const pad = r.name.padEnd(20);
    if (r.ok) {
      console.log(`  OK   [${pad}] ${r.dur}ms`);
      okCount++;
    } else {
      console.log(`  FAIL [${pad}] ${r.dur}ms  ${r.error || `http_${r.status}`}`);
      failCount++;
    }
  }

  console.log(`\n=== RESUMO ===`);
  console.log(`  DB:      ${db.ok ? 'OK' : 'FAIL'}`);
  console.log(`  Svcs OK: ${okCount}/${ENDPOINTS.length}`);
  if (failCount > 0) console.log(`  FAIL:    ${failCount}`);

  process.exit(failCount > 0 || !db.ok ? 1 : 0);
})();
