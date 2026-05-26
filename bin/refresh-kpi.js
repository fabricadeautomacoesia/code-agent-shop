#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { query, close } = require('@cas/db-client');
const { logger } = require('@cas/shared');

const log = logger.child({ bin: 'refresh-kpi' });

async function main() {
  log.info('[refresh-kpi] start');
  await query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_seller_kpi');
  log.info('[refresh-kpi] done');
  await close();
}

main().catch((e) => { console.error(e); process.exit(1); });
