#!/usr/bin/env node
'use strict';

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcrypt');
const { query, close } = require('@cas/db-client');
const { logger } = require('@cas/shared');

const log = logger.child({ bin: 'seed' });

async function regenAdminHash() {
  const plain = process.env.ADMIN_INITIAL_PASSWORD || 'ChangeMe!2026';
  const hash = await bcrypt.hash(plain, 12);
  await query(
    `UPDATE users SET password_hash = $1
     WHERE email = $2`,
    [hash, 'fabricadeautomacoes0@gmail.com']
  );
  log.info({ email: 'fabricadeautomacoes0@gmail.com' }, '[seed] admin hash regenerated');
  log.warn('[seed] senha inicial: ' + plain + ' (TROCAR NO PRIMEIRO LOGIN)');
}

async function main() {
  const dir = path.join(__dirname, '..', 'db', 'seeds');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    log.info({ f }, '[seed] running');
    await query(sql);
  }
  await regenAdminHash();
  await close();
  log.info('[seed] done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
