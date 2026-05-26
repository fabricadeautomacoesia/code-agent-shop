'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const express = require('express');
const cron = require('node-cron');
const os = require('node:os');
const fs = require('node:fs/promises');
const { exec } = require('node:child_process');
const { promisify } = require('node:util');
const { query, healthcheck } = require('@cas/db-client');
const { logger, errorHandler, asyncHandler } = require('@cas/shared');

const execP = promisify(exec);
const log = logger.child({ svc: 'aiops-svc' });
const app = express();
const PORT = parseInt(process.env.PORT_AIOPS || '3006', 10);
const HOST = os.hostname();

const CPU_TH  = parseFloat(process.env.ALERT_CPU_THRESHOLD || '85');
const RAM_TH  = parseFloat(process.env.ALERT_RAM_THRESHOLD || '90');
const DISK_TH = parseFloat(process.env.ALERT_DISK_THRESHOLD || '90');
const AUTOHEAL_RAM = parseFloat(process.env.AUTOHEAL_RAM_THRESHOLD || '95');

app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

// ============================================================
// COLETA DE METRICAS
// ============================================================
async function collectMetrics() {
  const cpus = os.cpus();
  const load = os.loadavg();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const ramUsedMb = Math.round((totalMem - freeMem) / 1024 / 1024);
  const ramTotalMb = Math.round(totalMem / 1024 / 1024);
  const ramPct = ((totalMem - freeMem) / totalMem) * 100;

  // CPU pct aproximado: usa loadavg[0] / nproc
  const cpuPct = Math.min(100, (load[0] / cpus.length) * 100);

  // Disco (linux/macos via df, fallback graceful)
  let diskPct = null, diskTotalGb = null, diskUsedGb = null;
  try {
    const { stdout } = await execP('df -k / | tail -1');
    const parts = stdout.trim().split(/\s+/);
    if (parts.length >= 5) {
      diskTotalGb = parseInt(parts[1], 10) / 1024 / 1024;
      diskUsedGb  = parseInt(parts[2], 10) / 1024 / 1024;
      diskPct = parseFloat(parts[4].replace('%', ''));
    }
  } catch { /* windows, ignora */ }

  return {
    host: HOST,
    cpu_percent: Number(cpuPct.toFixed(2)),
    ram_percent: Number(ramPct.toFixed(2)),
    ram_total_mb: ramTotalMb,
    ram_used_mb: ramUsedMb,
    disk_percent: diskPct,
    disk_total_gb: diskTotalGb ? Number(diskTotalGb.toFixed(2)) : null,
    disk_used_gb: diskUsedGb ? Number(diskUsedGb.toFixed(2)) : null,
    load_avg_1m: load[0],
    load_avg_5m: load[1],
    load_avg_15m: load[2],
    process_count: cpus.length,
    extras: { platform: os.platform(), uptime_s: Math.floor(os.uptime()) },
  };
}

async function persistMetrics(m) {
  await query(
    `INSERT INTO metrics_history
       (host, cpu_percent, ram_percent, ram_total_mb, ram_used_mb,
        disk_percent, disk_total_gb, disk_used_gb,
        load_avg_1m, load_avg_5m, load_avg_15m, process_count, extras)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::JSONB)`,
    [m.host, m.cpu_percent, m.ram_percent, m.ram_total_mb, m.ram_used_mb,
     m.disk_percent, m.disk_total_gb, m.disk_used_gb,
     m.load_avg_1m, m.load_avg_5m, m.load_avg_15m, m.process_count, JSON.stringify(m.extras)]
  );
}

// ============================================================
// ALERTAS
// ============================================================
async function sendTelegramAlert(title, message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: `*[CAS AIOPS]* ${title}\n${message}`, parse_mode: 'Markdown' }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) { log.warn({ err: e.message }, '[alert.telegram.fail]'); }
}

async function dispatchAlert({ severity, source, code, title, message, targetType, targetId }) {
  const r = await query(
    `INSERT INTO alerts (severity, source, code, title, message, target_type, target_id, channels_sent)
     VALUES ($1,$2,$3,$4,$5,$6,$7, ARRAY['telegram','db']::TEXT[]) RETURNING id`,
    [severity, source, code, title, message, targetType || null, targetId || null]
  );
  await sendTelegramAlert(title, message);
  log.warn({ alert_id: r.rows[0].id, code, severity }, '[alert.dispatched]');
}

// ============================================================
// THRESHOLDS + AUTO-HEAL (V8 22.3)
// ============================================================
let alertCooldown = new Map(); // code -> timestamp

function shouldAlert(code, cooldownMs = 10 * 60 * 1000) {
  const last = alertCooldown.get(code);
  if (last && Date.now() - last < cooldownMs) return false;
  alertCooldown.set(code, Date.now());
  return true;
}

async function checkThresholds(m) {
  if (m.cpu_percent > CPU_TH && shouldAlert('cpu_high')) {
    await dispatchAlert({
      severity: 'warn', source: 'aiops', code: 'cpu_high',
      title: `CPU ${m.cpu_percent.toFixed(1)}%`, message: `CPU acima de ${CPU_TH}% no host ${m.host}`,
    });
  }
  if (m.ram_percent > RAM_TH && shouldAlert('ram_high')) {
    await dispatchAlert({
      severity: 'warn', source: 'aiops', code: 'ram_high',
      title: `RAM ${m.ram_percent.toFixed(1)}%`, message: `RAM acima de ${RAM_TH}% no host ${m.host}`,
    });
  }
  if (m.ram_percent > AUTOHEAL_RAM) {
    await autoHealRAM(m);
  }
  if (m.disk_percent !== null && m.disk_percent > DISK_TH && shouldAlert('disk_high')) {
    await dispatchAlert({
      severity: 'error', source: 'aiops', code: 'disk_high',
      title: `DISK ${m.disk_percent.toFixed(1)}%`, message: `Disco acima de ${DISK_TH}% no host ${m.host}`,
    });
  }
}

async function autoHealRAM(m) {
  log.warn({ ram: m.ram_percent }, '[autoheal.ram.triggered]');
  try {
    // Linux: limpa caches do kernel
    if (os.platform() === 'linux') {
      await execP('sync && echo 3 > /proc/sys/vm/drop_caches').catch(() => {});
    }
    await dispatchAlert({
      severity: 'critical', source: 'aiops', code: 'autoheal_ram',
      title: 'Auto-heal RAM disparado',
      message: `RAM em ${m.ram_percent.toFixed(1)}% no host ${m.host}. Cache de kernel limpo.`,
    });
  } catch (e) {
    log.error({ err: e.message }, '[autoheal.ram.fail]');
  }
}

// ============================================================
// SPIKE RELEASES (V8 4.3)
// ============================================================
async function releaseSpikeBlocks() {
  const r = await query(
    `DELETE FROM spike_events WHERE block_expires_at IS NOT NULL AND block_expires_at < NOW() RETURNING id`
  );
  if (r.rowCount > 0) log.info({ released: r.rowCount }, '[spike.released]');
}

// ============================================================
// CLEANUP RETENCAO 30d
// ============================================================
async function cleanupMetrics() {
  const r = await query(
    `DELETE FROM metrics_history WHERE collected_at < NOW() - INTERVAL '30 days' RETURNING id`
  );
  log.info({ deleted: r.rowCount }, '[metrics.cleanup]');
}

// ============================================================
// ENDPOINTS PUBLICOS
// ============================================================
app.get('/health', (_req, res) => res.json({
  ok: true, svc: 'aiops-svc', host: HOST,
  thresholds: { cpu: CPU_TH, ram: RAM_TH, disk: DISK_TH, autoheal_ram: AUTOHEAL_RAM }
}));

// /api/status - publica (mostrar status page)
app.get('/status', asyncHandler(async (_req, res) => {
  const db = await healthcheck();
  const m = await collectMetrics();
  const lastAlerts = await query(
    `SELECT id, severity, code, title, created_at FROM alerts
      WHERE created_at > NOW() - INTERVAL '24 hours'
      ORDER BY created_at DESC LIMIT 10`
  );
  res.json({
    ok: db.ok, host: HOST,
    metrics: m,
    db,
    recent_alerts: lastAlerts.rows,
    uptime_s: Math.floor(os.uptime()),
    services: {
      gateway: process.env.PORT_GATEWAY || 3002,
      auth: process.env.PORT_AUTH || 3010,
      seller: process.env.PORT_SELLER || 3011,
      product: process.env.PORT_PRODUCT || 3012,
      qa: process.env.PORT_QA || 3013,
      order: process.env.PORT_ORDER || 3015,
      payment: process.env.PORT_PAYMENT || 3016,
      review: process.env.PORT_REVIEW || 3017,
      notification: process.env.PORT_NOTIFICATION || 3018,
      search: process.env.PORT_SEARCH || 3019,
      vault: process.env.PORT_VAULT || 3020,
    },
  });
}));

app.get('/metrics/latest', asyncHandler(async (_req, res) => {
  const r = await query(`SELECT * FROM metrics_history ORDER BY collected_at DESC LIMIT 60`);
  res.json({ metrics: r.rows });
}));

app.get('/alerts/recent', asyncHandler(async (_req, res) => {
  const r = await query(
    `SELECT * FROM alerts WHERE created_at > NOW() - INTERVAL '7 days'
      ORDER BY created_at DESC LIMIT 100`
  );
  res.json({ alerts: r.rows });
}));

app.use((req, res) => res.status(404).json({ error: 'route_not_found' }));
app.use(errorHandler.errorMiddleware);

// ============================================================
// CRONS
// ============================================================
cron.schedule('*/10 * * * * *', async () => { // a cada 10s
  try {
    const m = await collectMetrics();
    await persistMetrics(m);
    await checkThresholds(m);
  } catch (e) { log.error({ err: e.message }, '[collect.err]'); }
});

cron.schedule('*/5 * * * *', () => releaseSpikeBlocks().catch(() => {})); // a cada 5min
cron.schedule('17 2 * * *', () => cleanupMetrics().catch(() => {}));      // diario 02:17

const server = app.listen(PORT, () => log.info({
  port: PORT, host: HOST,
  collect_interval_s: 10,
  thresholds: { cpu: CPU_TH, ram: RAM_TH, disk: DISK_TH, autoheal: AUTOHEAL_RAM }
}, '[aiops-svc] listening'));
['SIGINT','SIGTERM'].forEach((s) => process.on(s, () => server.close(() => process.exit(0))));
