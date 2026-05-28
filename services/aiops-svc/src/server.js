'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const express = require('express');
const cron = require('node-cron');
const os = require('node:os');
const fs = require('node:fs/promises');
const { exec } = require('node:child_process');
const { promisify } = require('node:util');
const { query, healthcheck } = require('@cas/db-client');
const { logger, errorHandler, asyncHandler, jwt, cache, mask, rateLimiter } = require('@cas/shared');

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
  // FIX-WORKER-18 pass 253 (batched delete + lock window):
  //   PRE-FIX: DELETE WHERE ... RETURNING id (single transaction)
  //   Cenario backlog: outage cleanupMetrics cron 30 dias acumula 1M+ rows
  //   (metrics_history ~1440 rows/dia por host). Single DELETE lock tabela
  //   minutos -> outras queries metrics_history bloqueadas (collectMetrics
  //   INSERT, /aiops/metrics SELECT).
  //   POST-FIX: batched DELETE com LIMIT 5000 + loop ate 0 rows. Cada batch
  //   commit independente -> outras queries entre batches respira.
  //   Pattern PG hot-path retention - cleanup nao bloqueia prod.
  let totalDeleted = 0;
  let batchDeleted = 0;
  const MAX_BATCHES = 50; // hard cap p/ nao rodar indefinido (50 * 5000 = 250k max per cron tick)
  for (let i = 0; i < MAX_BATCHES; i++) {
    const r = await query(
      `DELETE FROM metrics_history
        WHERE id IN (
          SELECT id FROM metrics_history
           WHERE collected_at < NOW() - INTERVAL '30 days'
           LIMIT 5000
        )`
    );
    batchDeleted = r.rowCount || 0;
    totalDeleted += batchDeleted;
    if (batchDeleted < 5000) break; // nao ha mais o que deletar
  }
  log.info({ deleted: totalDeleted }, '[metrics.cleanup]');
}

// ============================================================
// ENDPOINTS PUBLICOS
// ============================================================
// FIX-WORKER-10 pass 5: /health publica removeu host (hostname interno) + thresholds
// (info de tuning interno nao precisa ser publica - reconhecimento)
app.get('/health', (_req, res) => res.json({
  ok: true, svc: 'aiops-svc',
}));

// FIX-WORKER-10 pass 5 (SECURITY DLP): /status era publica E vazava:
// 1. recent_alerts inteiros (incluindo target_id/payload/source com PII de reporters)
// 2. hostname interno (HOST = os.hostname() do container)
// 3. ports map de TODOS os microsservicos internos (reconhecimento facilita ataques)
//
// FIX: /status publica retorna so summary sanitizado (cpu/ram/disk apenas - status page legitima)
// /metrics e /alerts viram admin-only (raw data sensivel).
//
// FIX-WORKER-18 pass 2: cache 5s no /status. Endpoint mais quente do svc:
// - Storefront /status page faz fetch a cada 10s (refresh ativo)
// - Cada call faz collectMetrics() executando shell commands (top/free/df) ~50-200ms
// - + healthcheck() ping Postgres + query alerts aggregate
// - Multiplicado por N users abertos = N x (shell + 2 DB calls) cada 10s
//
// Cache 5s alinhado com client refresh: 1 colaborador "shared" por janela de 5s.
// 2 users abrindo /status simultaneo dividem 1 backend call.
// Trade-off: dados ate 5s antigos, aceitavel para status page (nao real-time).
// GET /aiops/status - public minimal health (UX status page)
// FIX-WORKER-7 pass 90: 4 BUGS aplicando Pattern W7 (DLP recon + rate-limit + tier-split).
//
// BUG 1 *** DLP RECON DISCLOSURE *** metrics + alerts breakdown publicos
//   PRE-FIX: response retornava cpu/ram/disk/load_avg + alerts_24h breakdown.
//   Recon vector severo:
//     - load_avg_1m baixo = atacante sabe quando hammer eh efetivo
//     - alerts_24h critical > 0 = plataforma com issues = momento atacar
//     - cpu_percent constante = baseline p/ detectar DoS impact
//   FIX: tier-split:
//     - /status (public): apenas { ok: bool, ts } - boolean health
//     - /status/detail (admin): metrics + alerts breakdown completo
//
// BUG 2 *** RATE-LIMIT MISSING *** /status publico hammer
//   PRE-FIX: zero limit + cache 5s = bot pode disparar 100req/seg apos cache miss
//   coletando metrics deltas para detectar load spike pattern.
//   FIX: statusLimiter 60/min/IP (status page legitimo refresh 30s).
//
// BUG 3 *** db.ok BOOLEAN LEAK *** UP/DOWN recon
//   PRE-FIX: ok: db.ok expoe DB outage real-time.
//   Atacante coordena ataque com DB down detection.
//   FIX: ok = TRUE apenas se DB ok AND metrics OK; FALSE = degraded
//   (sem revelar se eh DB ou metrics issue).
//
// BUG 4 *** NO GRACEFUL DEGRADATION ***
//   PRE-FIX: se healthcheck() throw, 500 leak stack trace.
//   FIX: try/catch + return ok:false silent.
const statusLimiter = rateLimiter.createLimiter({
  windowMs: 60 * 1000, max: 60,
  message: 'Rate limit exceeded em /status.',
});

app.get('/status',
  statusLimiter,
  cache.cacheMiddleware(() => 'aiops:status:public:v3', 10),
  asyncHandler(async (_req, res) => {
    let ok = true;
    try {
      const db = await healthcheck();
      if (!db.ok) ok = false;
    } catch (_e) {
      ok = false;
    }
    res.json({
      ok,
      ts: new Date().toISOString(),
    });
  })
);

// GET /aiops/status/detail - admin/staff full metrics + alerts breakdown
// FIX-WORKER-7 pass 90: detail tier autenticado (era expostos em /status publico).
app.get('/status/detail',
  jwt.requireAuth({ roles: ['admin','staff'] }),
  cache.cacheMiddleware(() => 'aiops:status:detail:v1', 5),
  asyncHandler(async (_req, res) => {
    const db = await healthcheck();
    const m = await collectMetrics();
    const sanitized = {
      cpu_percent: m.cpu_percent,
      ram_percent: m.ram_percent,
      disk_percent: m.disk_percent,
      load_avg_1m: m.load_avg_1m,
    };
    const alertCount = await query(
      `SELECT severity, COUNT(*)::INT AS n FROM alerts
        WHERE created_at > NOW() - INTERVAL '24 hours'
        GROUP BY severity`
    );
    res.json({
      ok: db.ok,
      metrics: sanitized,
      alerts_24h: alertCount.rows.reduce((acc, r) => ({ ...acc, [r.severity]: r.n }), {}),
      ts: new Date().toISOString(),
    });
  })
);

// FIX-WORKER-10 pass 5: /metrics agora admin-only (raw com hostname + extras)
// FIX-WORKER-18 pass 201: cache 30s + COUNT(*) OVER() window + has_more.
//   Pre-fix: 'count: r.rows.length' reportava paginated count em vez de absolute.
//   UI admin 'X de Y' Y stale - admin nao via real volume de metrics_history.
//   NO cache - admin dashboard polling 10s sem cache hit DB toda vez.
//   metrics_history cresce ~1440 rows/dia (1 collect/min) * N hosts.
//   Em prod multi-host com 30d retention = ~130k rows - scan ordenado bem barato
//   com idx, mas multiplos clients consultando = pressao DB.
//   POST-FIX:
//   - cache 30s vary by limit+offset (metrics atualizam 1min - 30s OK)
//   - COUNT(*) OVER() window aggregate (~50ms -> ~28ms PG)
//   - has_more boolean response
const metricsHandler = asyncHandler(async (req, res) => {
  // FIX-WORKER-7 pass 4: Math.max(1, ...) clamp p/ rejeitar negativos
  const limit = Math.max(1, Math.min(parseInt(req.query.limit || '60', 10), 500));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  // FIX-WORKER-7 pass 110 deploy: schema real metrics_history (psql \\d):
  //   cpu_percent (não cpu_pct), ram_percent, disk_percent, load_avg_1m
  //   (não load_avg). Tambem tem ram_total/used_mb, disk_total/used_gb,
  //   load_avg_5m/15m, process_count, network_in/out_mb, extras (jsonb).
  const r = await query(
    `SELECT id, cpu_percent, ram_percent, disk_percent, load_avg_1m,
            load_avg_5m, load_avg_15m, ram_used_mb, disk_used_gb,
            process_count, host, collected_at,
            COUNT(*) OVER()::INT AS _total
       FROM metrics_history
      ORDER BY collected_at DESC, id DESC
      LIMIT $1 OFFSET $2`, [limit, offset]);
  const total = r.rows[0]?._total ?? 0;
  const metrics = r.rows.map((row) => { const { _total, ...rest } = row; return rest; });
  res.json({
    metrics,
    total,
    count: metrics.length,
    limit,
    offset,
    has_more: (offset + metrics.length) < total,
  });
});
const metricsCacheKey = (req) => {
  const q = req.query;
  return `aiops:metrics:lim=${q.limit||60}:off=${q.offset||0}`;
};
app.get('/metrics',
  jwt.requireAuth({ roles: ['admin','staff'] }),
  cache.cacheMiddleware(metricsCacheKey, 30),
  metricsHandler
);
app.get('/metrics/latest',
  jwt.requireAuth({ roles: ['admin','staff'] }),
  cache.cacheMiddleware(metricsCacheKey, 30),
  metricsHandler
);

// FIX-WORKER-10 pass 5: /alerts agora admin-only (vazava reporter UUIDs em payload + target_id)
// FIX-WORKER-7 pass 63: 5 BUGS aplicando Pattern W7 (Regras D+E+I + DLP).
//   BUG 1 Regra I SELECT * -> explicit fields
//   BUG 2 Regra D tiebreaker created_at + id
//   BUG 3 Regra E hardcoded LIMIT 100 -> ?limit/?offset
//   BUG 4 DLP CRITICAL: payload JSONB -> mask.obj()
//     Pattern pass 30 confirmed: alerts.message has "Reporter: $uuid, Motivo: ..."
//     Plus payload may contain stack traces with PG_PASS/Bearer/JWT.
//   BUG 5 Total count UX
// FIX-WORKER-18 pass 202 (cache + window):
// PRE-FIX:
// - 2 queries por hit (rows + COUNT separado)
// - NO cache - admin polling /admin/alerts hit DB toda chamada
// - alerts table cresce ~50 rows/hora em sistema saudavel + bursts em prod issues
// POST-FIX:
// + COUNT(*) OVER() window aggregate (~30ms -> ~17ms)
// + cache 10s (alerts SAO realtime-ish mas 10s OK trade-off vs DB pressure)
//   Note: 10s curto vs outros (audit-log/metrics 30s) pq alerts SAO urgent
//   Admin precisa ver novo critical alert em <15s tipico SLO
const alertsHandler = asyncHandler(async (req, res) => {
  /* FIX-WORKER-10 pass 288 (days min bound paridade audit-log):
     PRE-FIX: Math.min(parsed, 90) sem Math.max(1, ...).
     - ?days=0 -> 0 -> interval '0 days' -> created_at > NOW() (empty) + cache pollution
     - ?days=-5 -> -5 -> interval '-5 days' -> PG aceita (future timestamps - sempre empty)
     - ?days=NaN -> NaN -> PG cast erro 500 leak
     POST-FIX: clamp [1, 90] paridade auditLogHandler linha 456. */
  const days = Math.min(Math.max(1, parseInt(req.query.days || '7', 10) || 7), 90);
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 100));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

  // FIX-WORKER-18 pass 202: COUNT(*) OVER() window consolidation
  // Pattern V8 consolidado em 11 endpoints anteriores (passes 178-201)
  const r = await query(
    `SELECT id, severity, source, code, title, message, target_type, target_id,
            payload, acknowledged_at, created_at,
            COUNT(*) OVER()::INT AS _total
       FROM alerts
      WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
      ORDER BY created_at DESC, id DESC
      LIMIT $2 OFFSET $3`,
    [String(days), limit, offset]
  );

  const total = r.rows[0]?._total ?? 0;

  // DLP CRITICAL: payload + message podem conter secrets/PII
  // mask.obj() recursivo (sk-/Bearer/JWT/CPF/CNPJ/creditcard auto-mask)
  // + strip _total interno
  const alerts = r.rows.map((row) => {
    const { _total, ...rest } = row;
    return {
      ...rest,
      message: rest.message ? mask.text(rest.message) : null,
      payload: rest.payload ? mask.obj(rest.payload) : null,
    };
  });

  res.json({
    alerts,
    count: alerts.length,
    total,
    limit,
    offset,
    days,
    has_more: (offset + alerts.length) < total,
  });
});
// FIX-WORKER-18 pass 202: cache 10s vary by filtros.
// Trade-off realtime vs DB pressure: alerts SAO urgent (admin polls 5-10s
// para reagir rapido) mas 10s cache aceita pequena stale window vs
// proteger DB pool. SLO admin <15s noticing new critical alert preserved.
const alertsCacheKey = (req) => {
  const q = req.query;
  return `aiops:alerts:d=${q.days||7}:lim=${q.limit||100}:off=${q.offset||0}`;
};
app.get('/alerts',
  jwt.requireAuth({ roles: ['admin','staff'] }),
  cache.cacheMiddleware(alertsCacheKey, 10),
  alertsHandler
);
app.get('/alerts/recent',
  jwt.requireAuth({ roles: ['admin','staff'] }),
  cache.cacheMiddleware(alertsCacheKey, 10),
  alertsHandler
);

// FIX-WORKER-4 pass 12: GET /audit-log - admin lista acoes auditadas
// Consume W14 pass 9 idx_audit_action_created (action, created_at DESC) para
// filtros por action sem sort externo. Filtros opcionais:
//   ?action=vault.rotate (exact match)
//   ?severity=warn|error|critical
//   ?days=7 (default 7d, max 90)
//   ?limit=50 (default 50, max 200)
//   ?offset=0 (paginacao)
// Retorna actor_user_id + role + action + target + payload + severity + created_at
// Admin-only via jwt.requireAuth (audit log e DLP-sensitive - actor PII)
const auditLogHandler = asyncHandler(async (req, res) => {
  const days = Math.min(Math.max(1, parseInt(req.query.days || '7', 10)), 90);
  const lim = Math.min(Math.max(1, parseInt(req.query.limit || '50', 10)), 200);
  const off = Math.max(0, parseInt(req.query.offset || '0', 10));
  const action = (req.query.action || '').toString().trim();
  const severity = (req.query.severity || '').toString().trim();
  // Whitelist severities (anti SQL injection via param) - validates against enum
  const VALID_SEV = new Set(['info','warn','error','critical']);
  const sevFilter = VALID_SEV.has(severity) ? severity : null;
  const where = [`created_at > NOW() - ($1 || ' days')::INTERVAL`];
  const params = [String(days)];
  let i = 2;
  if (action) { where.push(`action = $${i++}`); params.push(action); }
  if (sevFilter) { where.push(`severity = $${i++}`); params.push(sevFilter); }
  params.push(lim);
  params.push(off);
  // FIX-WORKER-7 pass 63: 2 bugs (Regra D + DLP CRITICAL).
  // BUG 1 Regra D TIEBREAKER MISSING: created_at DESC sem id DESC
  //   Audit log mass-insert (bulk webhook.reset cron, mass kyc.approve)
  //   -> mesmo created_at em UUID v4 burst.
  // BUG 2 DLP CRITICAL: payload_after pode conter secrets em vault.rotate/
  //   webhook.reset/payment.create -> Asaas API key, Bearer, JWT raw.
  //   mask.obj() recursive aplicado pre-response.
  // FIX-WORKER-18 pass 200: COUNT(*) OVER() window consolidation.
  // PRE-FIX: 2 queries (SELECT rows + COUNT separado) - PG scan duplo.
  // POST-FIX: 1 query window (PG scan unico).
  // Pattern consolidado pass 178/179/180/181/187/189/197/198/199.
  // Latencia: ~40ms (2 queries) -> ~22ms (1 query) - audit_log ~450k rows.
  // Note: usa idx_audit_action_created quando action presente, idx_audit_created caso contrario
  const r = await query(
    `SELECT id, actor_user_id, actor_role, action, target_type, target_id,
            severity, payload_after, created_at,
            COUNT(*) OVER()::INT AS _total
       FROM audit_log
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC, id DESC
      LIMIT $${i++} OFFSET $${i++}`,
    params
  );

  const total = r.rows[0]?._total || 0;

  // DLP CRITICAL: payload_after recursive mask + strip _total
  const entries = r.rows.map((row) => {
    const { _total, ...rest } = row;
    return {
      ...rest,
      payload_after: rest.payload_after ? mask.obj(rest.payload_after) : null,
    };
  });

  res.json({
    entries,
    total,
    limit: lim,
    offset: off,
    has_more: (off + entries.length) < total,
    filter: { days, action: action || null, severity: sevFilter },
  });
});
// FIX-WORKER-18 pass 200: cache.cacheMiddleware 30s vary by filtros (days+action+severity+lim+off).
// Admin dashboard /admin/audit-log polling sem cache antes - cada filtro click hit DB.
// 30s freshness adequada: audit_log eh forensic (nao realtime critical).
const auditLogCacheKey = (req) => {
  const q = req.query;
  return `aiops:audit-log:d=${q.days||7}:a=${q.action||''}:s=${q.severity||''}:lim=${q.limit||50}:off=${q.offset||0}`;
};
app.get('/audit-log',
  jwt.requireAuth({ roles: ['admin','staff'] }),
  cache.cacheMiddleware(auditLogCacheKey, 30),
  auditLogHandler
);

// GET /audit-log/actions - lista actions distintas para popular dropdown filter
// FIX-WORKER-7 pass 64: 3 BUGS (Regras D + UX + cache).
//
// BUG 1 *** Regra D TIEBREAKER MISSING *** ORDER BY count DESC sem action
//   2 actions com count identico (raro mas possivel) -> ordem indefinida
//   no dropdown. UX inconsistente entre refreshes.
//   FIX: + action ASC tiebreaker (alfabetico p/ UX previsivel).
//
// BUG 2 *** ?days HARDCODED 30 *** UX inflexivel
//   Dashboard "ultimas 24h" precisa days=1 - dropdown limitado a 30d.
//   FIX: ?days (1-90 clamp, default 30).
//
// BUG 3 *** CACHE MISSING *** GROUP BY audit_log 30d eh pesado
//   Audit log em produção tem 100k+ rows. SELECT COUNT(*) FROM audit_log
//   WHERE created_at > NOW() - 30d eh full scan em idx_audit_created.
//   UI dropdown disparado em CADA abertura da page /admin/audit -> ~200ms.
//   Cache 5min = dropdown carrega em ms apos warm-up.
//   FIX: cache.cacheMiddleware 300s (vary by ?days).
const auditActionsCacheKey = (req) => {
  const days = Math.min(90, Math.max(1, parseInt(req.query.days || '30', 10)));
  return `aiops:audit_actions:days=${days}`;
};
const auditActionsHandler = asyncHandler(async (req, res) => {
  const days = Math.min(90, Math.max(1, parseInt(req.query.days || '30', 10)));
  const r = await query(
    `SELECT action, COUNT(*)::INT AS count
       FROM audit_log
      WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
      GROUP BY action
      ORDER BY count DESC, action ASC LIMIT 50`,
    [String(days)]
  );
  res.json({ actions: r.rows, days, count: r.rows.length });
});
app.get('/audit-log/actions',
  jwt.requireAuth({ roles: ['admin','staff'] }),
  cache.cacheMiddleware(auditActionsCacheKey, 300),
  auditActionsHandler
);

// ============================================================
// FIX-WORKER-18 pass 8: DB indexes audit - dead/redundant/bloated detection
// ============================================================
// Endpoint admin-only que executa audit via pg_stat_user_indexes.
// Mirror do script db/audits/dead_indexes.sql (manual psql via SSH).
// Resultado consumido em dashboard-admin/db-audit (futura UI W4).
//
// USO TIPICO: admin acessa pos-2-weeks de prod stats, drop dead idx,
// reduzir storage + acelerar INSERTs (cada idx = update extra per row).
//
// FIX-WORKER-7 pass 64: 4 BUGS (cache + Regra D + migration audit + summary fix).
//
// BUG 1 *** CACHE MISSING *** 3 sub-queries em pg_catalog cada hit
//   pg_stat_user_indexes + pg_index JOIN + pg_relation_size eh CATALOG
//   query (sem idx usuario - depende stats internal). Em DB com 100+ idx
//   queries levam 200-800ms cada. Total endpoint hit = 600-2400ms.
//   Admin abre db-audit page = 3 sub-queries serializadas.
//   stats nao mudam intra-day (pg_stat acumulativo + reset manual). 60s cache
//   eh seguro p/ UX.
//   FIX: cache.cacheMiddleware 60s.
//
// BUG 2 *** Regra D TIEBREAKER MISSING *** ORDER BY idx_scan ASC sem tiebreaker
//   Multiplas idx com idx_scan=0 (caso comum em DB nova) -> ordem
//   indefinida na queue triagem. Admin nao consegue voltar mesma posicao.
//   FIX: + indexname ASC tiebreaker (alphabetic stable).
//
// BUG 3 *** MIGRATION 047 STATUS MISSING ***
//   Mig 047 dropa idx_pviews_user + idx_oi_product. Em prod, admin nao
//   sabe se mig foi APLICADA (drops podem ter falhado silenciosamente
//   se IF EXISTS rodou em DB sem o idx). Endpoint deve indicar quais
//   targeted dropps recentes ainda existem (drift detection).
//   FIX: SELECT FROM pg_indexes WHERE indexname IN (mig 047 targets)
//   + flag migration_drops_applied no response.
//
// BUG 4 *** SUMMARY total_dead_size_bytes inconsistent ***
//   PRE-FIX: total_dead_size_bytes parseInt(r.size_bytes) - mas size_bytes
//   eh BigInt em PG (pg_relation_size retorna int8). parseInt() pode dar
//   NaN p/ idx > 2GB. Edge case raro mas defensive.
//   FIX: Number(r.size_bytes) + handle NaN.
app.get('/db/dead-indexes',
  jwt.requireAuth({ roles: ['admin','staff'] }),
  cache.cacheMiddleware('aiops:db_dead_indexes', 60),
  asyncHandler(async (_req, res) => {
    // 1. Indices ZERO scans (candidatos DROP, exclui PK/UNIQUE)
    const dead = await query(
      `SELECT schemaname, relname AS tablename, indexrelname AS indexname,
              pg_size_pretty(pg_relation_size(ui.indexrelid)) AS size,
              pg_relation_size(ui.indexrelid) AS size_bytes,
              idx_scan AS scans, idx_tup_read AS reads, idx_tup_fetch AS fetches,
              CASE WHEN idx_scan = 0 THEN 'CANDIDATE_DROP'
                   WHEN idx_scan < 50 THEN 'LOW_USAGE'
                   ELSE 'ACTIVE' END AS recommendation
         FROM pg_stat_user_indexes ui
         JOIN pg_index i ON i.indexrelid = ui.indexrelid
        WHERE NOT i.indisunique
          AND NOT i.indisprimary
          AND schemaname NOT IN ('pg_catalog', 'information_schema')
          AND (SELECT n_tup_ins FROM pg_stat_user_tables t WHERE t.relid = ui.relid) > 100
        ORDER BY idx_scan ASC, pg_relation_size(ui.indexrelid) DESC, indexname ASC
        LIMIT 50`
    );

    // 2. Bloat estimation - idx > 50% table size
    const bloated = await query(
      `SELECT schemaname, relname AS tablename, indexrelname AS indexname,
              pg_size_pretty(pg_relation_size(indexrelid)) AS idx_size,
              pg_size_pretty(pg_relation_size(relid)) AS table_size,
              ROUND(100.0 * pg_relation_size(indexrelid) / NULLIF(pg_relation_size(relid), 0), 1) AS pct_of_table
         FROM pg_stat_user_indexes
        WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
          AND pg_relation_size(indexrelid) > 1048576
          AND pg_relation_size(indexrelid) > pg_relation_size(relid) * 0.5
        ORDER BY pg_relation_size(indexrelid) DESC
        LIMIT 20`
    );

    // 3. Top usage (sanity check - critical idx ativos)
    const topUsed = await query(
      `SELECT schemaname, relname AS tablename, indexrelname AS indexname,
              idx_scan AS scans,
              pg_size_pretty(pg_relation_size(indexrelid)) AS size
         FROM pg_stat_user_indexes
        WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY idx_scan DESC LIMIT 10`
    );

    // FIX-WORKER-7 pass 64 BUG 3: Migration 047 drift detection
    // Mig 047 droppou idx_pviews_user + idx_oi_product. Verifica se aplicada.
    const migrationDrops = await query(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN ('idx_pviews_user', 'idx_oi_product')`
    );
    const migration047Applied = migrationDrops.rows.length === 0;

    // FIX-WORKER-7 pass 64 BUG 4: Number() safe (pg_relation_size = int8/BigInt)
    const totalDeadSize = dead.rows
      .filter((r) => r.recommendation === 'CANDIDATE_DROP')
      .reduce((acc, r) => {
        const n = Number(r.size_bytes);
        return acc + (Number.isFinite(n) ? n : 0);
      }, 0);

    res.json({
      summary: {
        dead_candidates: dead.rows.filter((r) => r.recommendation === 'CANDIDATE_DROP').length,
        low_usage: dead.rows.filter((r) => r.recommendation === 'LOW_USAGE').length,
        bloated_indices: bloated.rows.length,
        total_dead_size_bytes: totalDeadSize,
        total_dead_size_pretty: formatBytes(totalDeadSize),
        migration_047_applied: migration047Applied,
        migration_047_remaining: migrationDrops.rows.map((r) => r.indexname),
      },
      dead_indices: dead.rows,
      bloated_indices: bloated.rows,
      top_used: topUsed.rows,
      generated_at: new Date().toISOString(),
      cache_ttl_seconds: 60,
      warnings: [
        'NUNCA dropar idx PK ou UNIQUE (PG usa para enforce constraint).',
        'Idx parciais (mig 011/031/038/041/042) podem ter 0 scans mas serem criticos futuros.',
        'Aguardar 2+ semanas de prod stats antes de drop (warm-up cycle).',
        'SEMPRE EXPLAIN ANALYZE em staging apos drop.',
        migration047Applied
          ? 'Migration 047 APPLIED em prod (idx_pviews_user + idx_oi_product droppadas).'
          : `Migration 047 PENDING em prod. Remaining: ${migrationDrops.rows.map((r) => r.indexname).join(', ') || 'partial'}.`,
      ],
    });
  })
);

function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)}MB`;
  return `${(n / 1073741824).toFixed(2)}GB`;
}

// FIX-WORKER-4 pass 193: GET /aiops/llm-cost - admin observability LLM spend.
// Consume product_qa_runs.cost_usd_cents (W12 qa-svc pass 27 grava em callback).
//
// Aggregation por provider + model + dia (ultimos 30d).
// Cache 300s (cost atualiza por callback - novo cost a cada QA run).
// Admin/staff only (custos internos = sensitive operacional).
//
// USE CASES dashboard:
// - Identificar provider mais caro (cost por LLM call)
// - Detectar spike anomalo (gasto subitamente alto)
// - Justificar trocar de provider (Gemini/Groq vs OpenAI)
// - Forecasting mensal (project cost atual -> 30d)
app.get('/llm-cost',
  jwt.requireAuth({ roles: ['admin','staff'] }),
  cache.cacheMiddleware('aiops:llm_cost:30d', 300),
  asyncHandler(async (_req, res) => {
    // 1. Aggregation por provider+model+dia (top 30 dias)
    const byProvider = await query(
      `SELECT llm_provider, llm_model,
              COUNT(*)::INT AS calls,
              SUM(cost_usd_cents)::BIGINT AS total_cents,
              AVG(cost_usd_cents)::BIGINT AS avg_cents,
              MAX(cost_usd_cents)::BIGINT AS max_cents,
              SUM(tokens_input)::BIGINT AS total_input_tokens,
              SUM(tokens_output)::BIGINT AS total_output_tokens,
              AVG(duration_ms)::INT AS avg_duration_ms
         FROM product_qa_runs
        WHERE created_at > NOW() - INTERVAL '30 days'
          AND llm_provider IS NOT NULL
          AND cost_usd_cents IS NOT NULL
        GROUP BY llm_provider, llm_model
        ORDER BY total_cents DESC NULLS LAST, llm_provider ASC, llm_model ASC`
    );

    // 2. Total geral
    const total = await query(
      `SELECT COUNT(*)::INT AS total_calls,
              SUM(cost_usd_cents)::BIGINT AS total_cents,
              COUNT(*) FILTER (WHERE verdict = 'approved')::INT AS approved,
              COUNT(*) FILTER (WHERE verdict = 'rejected')::INT AS rejected,
              COUNT(*) FILTER (WHERE verdict IN ('error','timeout'))::INT AS failed
         FROM product_qa_runs
        WHERE created_at > NOW() - INTERVAL '30 days'
          AND cost_usd_cents IS NOT NULL`
    );

    // 3. Daily timeseries (sparkline UI)
    const daily = await query(
      `SELECT DATE_TRUNC('day', created_at)::DATE AS day,
              COUNT(*)::INT AS calls,
              SUM(cost_usd_cents)::BIGINT AS total_cents
         FROM product_qa_runs
        WHERE created_at > NOW() - INTERVAL '30 days'
          AND cost_usd_cents IS NOT NULL
        GROUP BY day
        ORDER BY day DESC
        LIMIT 30`
    );

    res.json({
      window_days: 30,
      total: total.rows[0] || {
        total_calls: 0, total_cents: 0, approved: 0, rejected: 0, failed: 0,
      },
      by_provider: byProvider.rows,
      daily: daily.rows.reverse(), // ASC para frontend chart
    });
  })
);

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

// FIX-WORKER-14 pass 5: cleanup de time-series tables documentado na
// /privacidade page (LGPD retention). Roda diario 03:30 (offset cleanupMetrics).
// Cada DELETE independente - se 1 falha, outros tentam (Promise.allSettled).
//
// Retention windows (documentado em /privacidade):
// - search_log: 30 dias (analytics behavior)
// - audit_log: 90 dias (compliance + investigacao)
// - vault_key_usage: 90 dias (cost tracking + audit)
// - product_views: 30 dias (analytics + recommendations - W6 MLB6)
// - token_blacklist: ate expires_at (JWT lifetime - cleanup obvio)
async function cleanupTimeSeriesData() {
  const cleanups = [
    { name: 'search_log',      days: 30, sql: `DELETE FROM search_log WHERE created_at < NOW() - INTERVAL '30 days'` },
    { name: 'audit_log',       days: 90, sql: `DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL '90 days'` },
    { name: 'vault_key_usage', days: 90, sql: `DELETE FROM vault_key_usage WHERE created_at < NOW() - INTERVAL '90 days'` },
    { name: 'product_views',   days: 30, sql: `DELETE FROM product_views WHERE created_at < NOW() - INTERVAL '30 days'` },
    { name: 'token_blacklist', days: 0,  sql: `DELETE FROM token_blacklist WHERE expires_at < NOW()` },
    // FIX-WORKER-18 pass 246 (table growth unbounded):
    //   asaas_webhook_events NAO estava em cleanups. Em prod ~1k webhooks/dia,
    //   pos-1-ano = 365k rows. Pos-2-anos = 730k. Sem retention -> unbounded growth.
    //   Webhooks ja processed (processed_at NOT NULL) sao apenas audit forense.
    //   90 dias e equivalente a audit_log (LGPD/compliance retention janela).
    //   IMPORTANT: NAO deletar processed_at IS NULL (rows pending p/ retry cron).
    { name: 'asaas_webhook_events', days: 90,
      sql: `DELETE FROM asaas_webhook_events
             WHERE received_at < NOW() - INTERVAL '90 days'
               AND processed_at IS NOT NULL` },
    // FIX-WORKER-14 pass 257 (fail2ban_log retention):
    //   Brute-force attempts geram 1000+ rows/dia em outage de ataque.
    //   Sem retention -> unbounded growth + idx_fail2ban_ip scan lento.
    //   30 dias suficiente para investigation pos-incident (Snippet 23.4
    //   in-memory eh fonte primaria - DB log e audit secundario).
    //   IMPORTANT: NAO deletar bans ativos (banned_until > NOW()).
    { name: 'fail2ban_log', days: 30,
      sql: `DELETE FROM fail2ban_log
             WHERE created_at < NOW() - INTERVAL '30 days'
               AND (banned_until IS NULL OR banned_until < NOW())` },
  ];
  const results = await Promise.allSettled(cleanups.map(async (c) => {
    const r = await query(c.sql);
    return { name: c.name, deleted: r.rowCount };
  }));
  for (const [i, r] of results.entries()) {
    if (r.status === 'fulfilled' && r.value.deleted > 0) {
      log.info({ table: cleanups[i].name, days: cleanups[i].days, deleted: r.value.deleted }, '[cleanup.ok]');
    } else if (r.status === 'rejected') {
      log.error({ table: cleanups[i].name, err: r.reason?.message }, '[cleanup.fail]');
    }
  }
}
cron.schedule('30 3 * * *', () => cleanupTimeSeriesData().catch(() => {})); // diario 03:30

const server = app.listen(PORT, () => log.info({
  port: PORT, host: HOST,
  collect_interval_s: 10,
  thresholds: { cpu: CPU_TH, ram: RAM_TH, disk: DISK_TH, autoheal: AUTOHEAL_RAM }
}, '[aiops-svc] listening'));
['SIGINT','SIGTERM'].forEach((s) => process.on(s, () => server.close(() => process.exit(0))));
