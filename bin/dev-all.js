#!/usr/bin/env node
'use strict';

/**
 * dev-all.js - sobe os 12 servicos backend + 3 frontends + qa-worker em paralelo (dev mode).
 * Cada um em sub-processo isolado, com cores e prefixos no log.
 */

require('dotenv').config();
const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const COLORS = ['\x1b[36m','\x1b[35m','\x1b[32m','\x1b[33m','\x1b[34m','\x1b[31m','\x1b[37m','\x1b[96m','\x1b[95m','\x1b[92m','\x1b[93m','\x1b[94m','\x1b[91m','\x1b[97m','\x1b[36m','\x1b[35m'];
const RESET = '\x1b[0m';

const SERVICES = [
  { name: 'gateway',          cmd: 'node', args: ['--watch', 'src/server.js'], cwd: 'services/gateway' },
  { name: 'auth-svc',         cmd: 'node', args: ['--watch', 'src/server.js'], cwd: 'services/auth-svc' },
  { name: 'vault-svc',        cmd: 'node', args: ['--watch', 'src/server.js'], cwd: 'services/vault-svc' },
  { name: 'seller-svc',       cmd: 'node', args: ['--watch', 'src/server.js'], cwd: 'services/seller-svc' },
  { name: 'product-svc',      cmd: 'node', args: ['--watch', 'src/server.js'], cwd: 'services/product-svc' },
  { name: 'qa-svc',           cmd: 'node', args: ['--watch', 'src/server.js'], cwd: 'services/qa-svc' },
  { name: 'qa-worker',        cmd: 'python', args: ['-m', 'uvicorn', 'app.main:app', '--host', '0.0.0.0', '--port', '3014'], cwd: 'services/qa-worker' },
  { name: 'order-svc',        cmd: 'node', args: ['--watch', 'src/server.js'], cwd: 'services/order-svc' },
  { name: 'payment-svc',      cmd: 'node', args: ['--watch', 'src/server.js'], cwd: 'services/payment-svc' },
  { name: 'review-svc',       cmd: 'node', args: ['--watch', 'src/server.js'], cwd: 'services/review-svc' },
  { name: 'notification-svc', cmd: 'node', args: ['--watch', 'src/server.js'], cwd: 'services/notification-svc' },
  { name: 'search-svc',       cmd: 'node', args: ['--watch', 'src/server.js'], cwd: 'services/search-svc' },
  { name: 'aiops-svc',        cmd: 'node', args: ['--watch', 'src/server.js'], cwd: 'services/aiops-svc' },
  { name: 'storefront',       cmd: 'npm',  args: ['run', 'dev'], cwd: 'apps/storefront' },
  { name: 'admin',            cmd: 'npm',  args: ['run', 'dev'], cwd: 'apps/dashboard-admin' },
  { name: 'seller-ui',        cmd: 'npm',  args: ['run', 'dev'], cwd: 'apps/dashboard-seller' },
];

const procs = [];
SERVICES.forEach((svc, idx) => {
  const color = COLORS[idx % COLORS.length];
  const pad = svc.name.padEnd(20);
  const p = spawn(svc.cmd, svc.args, {
    cwd: path.join(ROOT, svc.cwd),
    env: process.env,
    shell: process.platform === 'win32',
  });
  const tag = `${color}[${pad}]${RESET}`;
  p.stdout.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach((l) => console.log(`${tag} ${l}`)));
  p.stderr.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach((l) => console.error(`${tag} ${l}`)));
  p.on('exit', (code) => console.log(`${tag} exited code=${code}`));
  p.on('error', (e) => console.error(`${tag} ERR ${e.message}`));
  procs.push(p);
});

console.log('\n=== Code & Agent Shop - DEV mode ===');
console.log(`Subindo ${SERVICES.length} processos...`);
console.log('Gateway: http://localhost:3002');
console.log('Store:   http://localhost:3000');
console.log('Admin:   http://localhost:3001');
console.log('Seller:  http://localhost:3003');
console.log('AIOps:   http://localhost:3006/status\n');

['SIGINT','SIGTERM'].forEach((sig) => process.on(sig, () => {
  console.log(`\n${sig} recebido. Parando...`);
  procs.forEach((p) => p.kill());
  setTimeout(() => process.exit(0), 2000);
}));
