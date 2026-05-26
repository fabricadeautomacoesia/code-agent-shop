#!/usr/bin/env node
'use strict';

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { query, close } = require('@cas/db-client');
const { logger } = require('@cas/shared');

const log = logger.child({ bin: 'migrate' });

async function ensureMigrationsTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    VARCHAR(200) PRIMARY KEY,
      checksum    VARCHAR(64) NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      duration_ms INT
    );
  `);
}

async function main() {
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  log.info({ count: files.length, dir }, '[migrate] start');

  await ensureMigrationsTable();
  const already = new Set(
    (await query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename)
  );

  let applied = 0;
  for (const f of files) {
    if (already.has(f)) {
      log.debug({ f }, '[migrate] skip');
      continue;
    }
    const fullPath = path.join(dir, f);
    const sql = fs.readFileSync(fullPath, 'utf8');
    const crypto = require('node:crypto');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex');
    const t0 = Date.now();
    try {
      log.info({ f }, '[migrate] applying');
      await query(sql, []);
      const duration = Date.now() - t0;
      await query(
        'INSERT INTO schema_migrations (filename, checksum, duration_ms) VALUES ($1, $2, $3)',
        [f, checksum, duration]
      );
      applied++;
      log.info({ f, duration }, '[migrate] OK');
    } catch (e) {
      log.error({ f, err: e.message }, '[migrate] FAIL');
      throw e;
    }
  }
  log.info({ applied }, '[migrate] done');
  await close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
