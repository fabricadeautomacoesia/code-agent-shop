#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { Client } = require('pg');
const { spawnSync } = require('node:child_process');
const { logger } = require('@cas/shared');

const log = logger.child({ bin: 'reset' });

async function main() {
  if (process.env.NODE_ENV === 'production') {
    log.error('[reset] PROIBIDO em producao');
    process.exit(1);
  }
  const dbName = process.env.PG_DB || 'code_agent_shop';
  const admin = new Client({
    host: process.env.PG_HOST, port: process.env.PG_PORT,
    user: process.env.PG_USER, password: process.env.PG_PASS,
    database: 'postgres',
  });
  await admin.connect();
  log.warn({ db: dbName }, '[reset] DROP + CREATE');
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  spawnSync('node', ['bin/migrate.js'], { stdio: 'inherit' });
  spawnSync('node', ['bin/seed.js'],    { stdio: 'inherit' });
}

main().catch((e) => { console.error(e); process.exit(1); });
