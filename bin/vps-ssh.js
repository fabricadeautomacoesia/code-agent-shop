#!/usr/bin/env node
'use strict';
/**
 * vps-ssh.js - executa comandos SSH com senha via pty-like (node-pty alternativa simples).
 * Como nao temos node-pty, usamos spawn + stdin escrevendo apos detectar 'password:'.
 *
 * Uso: node bin/vps-ssh.js "<comandos remotos>"
 */
const { spawn } = require('node:child_process');

const VPS_HOST = process.env.VPS_HOST || '209.145.60.53';
const VPS_USER = process.env.VPS_USER || 'root';
const VPS_PASS = process.env.VPS_PASS || 'sW5pgAG9obRu';

const remoteCmd = process.argv[2];
if (!remoteCmd) {
  console.error('Uso: node bin/vps-ssh.js "comandos"');
  process.exit(2);
}

const child = spawn('ssh', [
  '-tt',  // forca tty (necessario para senha em stdin)
  '-o', 'StrictHostKeyChecking=no',
  '-o', 'UserKnownHostsFile=/dev/null',
  '-o', 'PreferredAuthentications=password,keyboard-interactive',
  '-o', 'PubkeyAuthentication=no',
  '-o', 'ConnectTimeout=15',
  `${VPS_USER}@${VPS_HOST}`,
  remoteCmd,
], { stdio: ['pipe', 'pipe', 'pipe'] });

let sentPw = false;
let buf = '';

child.stdout.on('data', (d) => {
  const s = d.toString();
  process.stdout.write(s);
  buf += s;
  if (!sentPw && (buf.toLowerCase().includes('password:') || buf.toLowerCase().includes('assword:'))) {
    sentPw = true;
    setTimeout(() => child.stdin.write(VPS_PASS + '\n'), 100);
  }
});
child.stderr.on('data', (d) => {
  const s = d.toString();
  process.stderr.write(s);
  buf += s;
  if (!sentPw && (s.toLowerCase().includes('password:') || s.toLowerCase().includes('assword:'))) {
    sentPw = true;
    setTimeout(() => child.stdin.write(VPS_PASS + '\n'), 100);
  }
});
child.on('exit', (code) => process.exit(code || 0));
child.on('error', (e) => { console.error('SSH spawn error:', e.message); process.exit(1); });

// timeout global de 5min
setTimeout(() => { console.error('Timeout 5min'); child.kill(); process.exit(124); }, 300000);
