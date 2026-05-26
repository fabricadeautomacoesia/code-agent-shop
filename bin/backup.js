#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { logger } = require('@cas/shared');

const log = logger.child({ bin: 'backup' });

async function main() {
  const dir = path.join(__dirname, '..', 'backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `cas-${ts}.sql.gz`);

  const env = {
    PGHOST: process.env.PG_HOST || '127.0.0.1',
    PGPORT: process.env.PG_PORT || '5432',
    PGUSER: process.env.PG_USER || 'codeshop',
    PGPASSWORD: process.env.PG_PASS,
    PGDATABASE: process.env.PG_DB || 'code_agent_shop',
  };

  log.info({ file }, '[backup] pg_dump start');
  const dump = spawn('pg_dump', ['--no-owner', '--clean', '--if-exists'], { env: { ...process.env, ...env } });
  const gzip = spawn('gzip', ['-9']);
  const out  = fs.createWriteStream(file);
  dump.stdout.pipe(gzip.stdin);
  gzip.stdout.pipe(out);
  dump.stderr.on('data', (d) => log.debug(d.toString()));

  await new Promise((res, rej) => {
    out.on('finish', res);
    out.on('error', rej);
    dump.on('error', rej);
    gzip.on('error', rej);
  });

  // Retencao 7 dias
  const files = fs.readdirSync(dir);
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  for (const f of files) {
    const stat = fs.statSync(path.join(dir, f));
    if (stat.mtime.getTime() < cutoff) {
      fs.unlinkSync(path.join(dir, f));
      log.info({ f }, '[backup] cleanup old');
    }
  }
  log.info({ file }, '[backup] done');
}

main().catch((e) => { console.error(e); process.exit(1); });
