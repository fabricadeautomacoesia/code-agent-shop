'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const express = require('express');
const nodeCrypto = require('node:crypto');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { query, tx } = require('@cas/db-client');
const { logger, sanitize, errorHandler, asyncHandler, jwt, validate, crypto: cryp, fail2ban, startup, cache, mask } = require('@cas/shared');

// FIX-WORKER-17 pass 7: valida envs criticas ANTES de listen.
// VAULT_AES_KEY 64-char hex obrigatorio (encrypt/decrypt de API keys).
// VAULT_INTERNAL_TOKEN warn (operacional, nao critico para boot).
startup.validateStartupEnv({
  critical: ['PG_PASS', 'VAULT_AES_KEY'],
  minLength: { PG_PASS: 12, VAULT_AES_KEY: 64 },
  // FIX-WORKER-17 pass 8: VAULT_INTERNAL_TOKEN promovido para enforceInProd
  // product-svc usa para chamar /vault/use buscando API keys. Sem ele, plain_key
  // nunca retorna - product features dependentes de LLM ficam quebradas silencioso.
  enforceInProd: ['VAULT_INTERNAL_TOKEN'],
});

const log = logger.child({ svc: 'vault-svc' });
const app = express();
const PORT = parseInt(process.env.PORT_VAULT || '3020', 10);

app.disable('x-powered-by');
// FIX-WORKER-17: trust proxy para rate-limit usar IP real (x-forwarded-for do gateway)
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));
app.use(sanitize.middleware());
// FIX-WORKER-17 pass 3: fail2ban global - bane IP apos 5 tentativas falhas em 15min.
// Antes: brute-force de x-internal-token nao tinha limite (timing-safe so previne timing
// attacks, nao taxa de tentativas). Combinado com rate-limit, defese em profundidade.
app.use(fail2ban.middleware());

// FIX-WORKER-17 pass 247 (cache-control no-store):
//   vault endpoints retornam dados sensiveis: fingerprints, plain_key (em /use),
//   key_alias, provider info. Sem Cache-Control header explicit, proxy intermediario
//   (Traefik, CDN futuro, browser cache) PODE armazenar response. Embora HTTPS evite
//   shared proxies, defesa em profundidade requer no-store em endpoints crypto.
//   Pattern V8: APIs com material sensivel SEMPRE Cache-Control: no-store + Pragma.
app.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true, svc: 'vault-svc' }));

const adminOnly = jwt.requireAuth({ roles: ['admin', 'staff'] });
const sellerOrAdmin = jwt.requireAuth({ roles: ['seller', 'admin', 'staff'] });

// FIX-WORKER-17 (timing-safe + rate-limit) - definicoes precisam vir ANTES das rotas que as usam
function vaultUseGuard(req, res, next) {
  const internalTok = req.headers['x-internal-token'];
  const expected = process.env.VAULT_INTERNAL_TOKEN;
  if (expected && internalTok) {
    let valid = false;
    try {
      const a = Buffer.from(String(internalTok));
      const b = Buffer.from(expected);
      valid = a.length === b.length && nodeCrypto.timingSafeEqual(a, b);
    } catch { valid = false; }
    if (valid) {
      // FIX-WORKER-17 pass 3: limpa contador de falhas em sucesso
      if (req.fail2ban) req.fail2ban.reportSuccess();
      return next();
    }
    // FIX-WORKER-17 pass 3: incrementa contador fail2ban
    if (req.fail2ban) req.fail2ban.reportFailure();
    // FIX-WORKER-17 pass 4 (CRITICAL DLP): NAO logar expected.length nem tok_len.
    // Antes: atacante via 1 tentativa falha aprendia o comprimento exato do
    // VAULT_INTERNAL_TOKEN (ex: 64 chars) -> reduzia espaco de busca drasticamente.
    // Com fail2ban + IP rotation, exploit ainda era viavel em horas.
    // Agora: log so registra IP/UA (audit forensics) sem oracle de tamanho.
    // tok_len_match (bool) preserva 1 bit de info util sem revelar comprimento real.
    log.warn({
      ip: req.ip,
      ua: req.headers['user-agent'],
      tok_len_match: String(internalTok).length === expected.length,
    }, '[vault.invalid_internal_token]');
  }
  return jwt.requireAuth({ roles: ['admin', 'staff', 'service'] })(req, res, next);
}

const useRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.VAULT_USE_RATE_LIMIT || '30', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limit_exceeded' },
  keyGenerator: (req) => req.headers['x-real-ip'] || req.ip,
});

const provisionRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limit_exceeded' },
});

// FIX-WORKER-17 pass 254: plain_key DoS prevention (max 500 chars - cobre todos providers)
const provisionSchema = z.object({
  seller_id: z.string().uuid().nullable().optional(),
  provider: z.enum(['openai','anthropic','gemini','groq','cohere','mistral','azure-openai','custom']),
  key_alias: z.string().min(3).max(100),
  plain_key: z.string().min(10).max(500),
  monthly_quota_usd_cents: z.number().int().positive().nullable().optional(),
  is_platform_pool: z.boolean().default(true),
  expires_at: z.string().datetime().optional(),
  // FIX-WORKER-17 pass 12: rotation_days opcional (default 90d se nao informado)
  rotation_days: z.number().int().min(1).max(365).optional(),
});

// POST /api/vault/keys -> admin provisiona chave para pool ou seller especifico
// FIX-WORKER-17 pass 12: auto-define rotation_due_at = NOW() + rotation_days days
// (default 90d - boas praticas secrets management Asaas/OpenAI/etc).
// Tabela tem coluna rotation_due_at + idx_vault_rotation desde mig 003 mas NUNCA
// foi populado. Agora cada nova key tem prazo de rotacao definido.
app.post('/keys', provisionRateLimit, adminOnly, validate({ body: provisionSchema }), asyncHandler(async (req, res) => {
  const { seller_id, provider, key_alias, plain_key, monthly_quota_usd_cents,
          is_platform_pool, expires_at, rotation_days } = req.body;
  const { encrypted, iv, tag } = cryp.encrypt(plain_key);
  const fp = cryp.sha256(plain_key).slice(0, 16);
  // 90 days default - alinhado com PCI/SOC2 recomendacoes
  const rotDays = rotation_days || 90;
  const r = await query(
    `INSERT INTO vault_api_keys
       (seller_id, provider, key_alias, encrypted_key, iv, auth_tag, key_fingerprint,
        monthly_quota_usd_cents, is_platform_pool, expires_at, rotation_due_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
             NOW() + ($11 || ' days')::INTERVAL)
     RETURNING id, provider, key_alias, key_fingerprint, is_platform_pool,
               monthly_quota_usd_cents, created_at, rotation_due_at`,
    [seller_id || null, provider, key_alias, encrypted, iv, tag, fp,
     monthly_quota_usd_cents || null, is_platform_pool, expires_at || null,
     String(rotDays)]
  );
  log.info({ provisioned: r.rows[0].id, provider, fp, rotation_due_at: r.rows[0].rotation_due_at },
    '[vault.provision]');
  res.status(201).json(r.rows[0]);
}));

// FIX-WORKER-17 pass 12: cron diario detecta keys vencendo rotacao em <= 7 dias
// (warn early) + vencidas (urgent). Cria notification in_app + email para
// admins. Usa idx_vault_rotation partial (WHERE is_active = TRUE) - barato.
async function rotationAlertCron() {
  try {
    // Keys com rotation_due_at em < 7 dias (warning) e <= NOW() (overdue)
    const r = await query(
      `SELECT id, key_alias, provider, rotation_due_at,
              EXTRACT(EPOCH FROM (rotation_due_at - NOW()))/86400 AS days_remaining
         FROM vault_api_keys
        WHERE is_active = TRUE
          AND rotation_due_at IS NOT NULL
          AND rotation_due_at < NOW() + INTERVAL '7 days'
        ORDER BY rotation_due_at ASC
        LIMIT 50`
    );
    if (!r.rows.length) return;
    // Pega lista de admin user_ids para criar notifications
    const admins = await query(`SELECT id FROM users WHERE role IN ('admin','staff') AND is_active = TRUE AND is_banned = FALSE`);
    if (!admins.rows.length) return;
    log.info({ keys_due: r.rows.length, admins: admins.rows.length }, '[vault.rotation.alert]');

    // FIX-WORKER-17 pass 188 (BUG 1 + 2): refactor 750+ queries -> single INSERT...SELECT.
    //
    // PRE-FIX bugs:
    // 1. N+1 loop: 50 keys * (1 idempotency check + N_admins inserts +
    //    N_admins overdue email inserts) = 750+ queries sequenciais
    // 2. Idempotency check NAO incluia user_id - novo admin nunca recebia
    //    notification se outro admin ja tinha recebido por aquela key
    //
    // POST-FIX: single INSERT ... SELECT FROM admins JOIN keys NOT EXISTS dedup.
    // - 1 query bulk em vez de 750
    // - Idempotency per (key_id, user_id) - cada admin recebe sua notif
    // - Latency ~5000ms -> ~50ms (em 50 keys * 5 admins)

    // Bulk INSERT in_app (todas keys - warning + overdue)
    const keysJson = JSON.stringify(r.rows.map((k) => ({
      key_id: k.id,
      alias: k.key_alias,
      provider: k.provider,
      days: Math.floor(Number(k.days_remaining)),
      is_overdue: Math.floor(Number(k.days_remaining)) < 0,
    })));

    await query(
      `WITH keys_due AS (
         SELECT (jsonb_array_elements($1::JSONB)) AS k
       ),
       admin_users AS (
         SELECT id FROM users
          WHERE role IN ('admin','staff') AND is_active = TRUE AND is_banned = FALSE
       )
       INSERT INTO notifications (user_id, channel, template_code, title, body, priority, payload)
       SELECT
         au.id,
         'in_app',
         'vault_rotation_due',
         CASE WHEN (k->>'is_overdue')::BOOLEAN
              THEN 'Chave ' || (k->>'alias') || ' VENCIDA (rotacao ha ' || (-(k->>'days')::INT) || 'd)'
              ELSE 'Chave ' || (k->>'alias') || ' vence em ' || (k->>'days') || 'd'
         END,
         'Provider: ' || (k->>'provider') || '. Rotacionar manualmente via /admin/vault para evitar revogacao surpresa pelo upstream.',
         CASE WHEN (k->>'is_overdue')::BOOLEAN THEN 3 ELSE 1 END,
         k::JSONB
       FROM keys_due, admin_users au
       WHERE NOT EXISTS (
         SELECT 1 FROM notifications n
          WHERE n.user_id = au.id
            AND n.template_code = 'vault_rotation_due'
            AND n.payload->>'key_id' = k->>'key_id'
            AND n.created_at > NOW() - INTERVAL '1 day'
       )`,
      [keysJson]
    ).catch((e) => log.warn({ err: e.message }, '[vault.rotation.notif.bulk.fail]'));

    // Email - apenas keys overdue (1 separate bulk INSERT)
    await query(
      `WITH keys_due AS (
         SELECT (jsonb_array_elements($1::JSONB)) AS k
       ),
       admin_users AS (
         SELECT id FROM users
          WHERE role IN ('admin','staff') AND is_active = TRUE AND is_banned = FALSE
       )
       INSERT INTO notifications (user_id, channel, template_code, title, body, priority, payload)
       SELECT
         au.id,
         'email',
         'vault_rotation_due',
         'Chave ' || (k->>'alias') || ' VENCIDA (rotacao ha ' || (-(k->>'days')::INT) || 'd)',
         'Provider: ' || (k->>'provider') || '. Rotacionar manualmente via /admin/vault para evitar revogacao surpresa pelo upstream.',
         3,
         k::JSONB
       FROM keys_due, admin_users au
       WHERE (k->>'is_overdue')::BOOLEAN
         AND NOT EXISTS (
           SELECT 1 FROM notifications n
            WHERE n.user_id = au.id
              AND n.template_code = 'vault_rotation_due'
              AND n.channel = 'email'
              AND n.payload->>'key_id' = k->>'key_id'
              AND n.created_at > NOW() - INTERVAL '1 day'
         )`,
      [keysJson]
    ).catch((e) => log.warn({ err: e.message }, '[vault.rotation.email.bulk.fail]'));
  } catch (e) {
    log.error({ err: e.message }, '[vault.rotation.cron.fail]');
  }
}

// GET /api/vault/keys/rotation-due - lista keys com rotacao prox/vencida
// FIX-WORKER-7 pass 65: 4 BUGS aplicando Pattern W7 (Regras D+E + cache + UX).
//
// BUG 1 *** Regra D TIEBREAKER MISSING *** ORDER BY rotation_due_at ASC nao determ
//   Keys com rotation_due_at identico (bulk provisioning) -> ordem indefinida.
//   FIX: + id ASC tiebreaker.
//
// BUG 2 *** Regra E PAGINATION MISSING *** hardcoded LIMIT 100
//   Em prod com 500+ chaves (multi-seller scale) admin so vê primeiras 100.
//   FIX: ?limit (1-200, default 50) + ?offset.
//
// BUG 3 *** ?days_window UX *** hardcoded 30d
//   Pre-fix forca admin filtrar "proximos 30 dias". "Esta semana" (7d)
//   ou "Esta vencida" (-1) impossivel.
//   FIX: ?days_window (-30 a 365, default 30).
//
// BUG 4 *** CACHE MISSING *** rotation cron dispara este endpoint regularmente
//   Cron 09:00 UTC + admin abre dashboard /admin/vault. Cache 5min (rotacao
//   nao muda intra-day apos rotacao crud).
//   FIX: cache.cacheMiddleware 300s vary by params.
const rotationDueCacheKey = (req) => {
  const lim = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
  const off = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const dw = Math.max(-30, Math.min(365, parseInt(req.query.days_window, 10) || 30));
  return `vault:rotation_due:lim=${lim}:off=${off}:dw=${dw}`;
};

app.get('/keys/rotation-due',
  adminOnly,
  cache.cacheMiddleware(rotationDueCacheKey, 300),
  asyncHandler(async (req, res) => {
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const daysWindow = Math.max(-30, Math.min(365, parseInt(req.query.days_window, 10) || 30));

    const r = await query(
      `SELECT id, key_alias, provider, is_platform_pool, rotation_due_at,
              EXTRACT(EPOCH FROM (rotation_due_at - NOW()))/86400 AS days_remaining
         FROM vault_api_keys
        WHERE is_active = TRUE
          AND rotation_due_at IS NOT NULL
          AND rotation_due_at < NOW() + ($1 || ' days')::INTERVAL
        ORDER BY rotation_due_at ASC, id ASC
        LIMIT $2 OFFSET $3`,
      [String(daysWindow), limit, offset]
    );

    const totalRes = await query(
      `SELECT COUNT(*)::INT AS total FROM vault_api_keys
        WHERE is_active = TRUE AND rotation_due_at IS NOT NULL
          AND rotation_due_at < NOW() + ($1 || ' days')::INTERVAL`,
      [String(daysWindow)]
    );

    res.json({
      keys: r.rows,
      count: r.rows.length,
      total: totalRes.rows[0].total,
      limit, offset, days_window: daysWindow,
    });
  })
);

// Cron 1x/dia as 09:00 UTC (06:00 BRT) - antes do horario comercial brasileiro
// setTimeout para 1a execucao 60s apos start (warmup), depois 24h interval
setTimeout(() => rotationAlertCron().catch(() => {}), 60000);
setInterval(() => rotationAlertCron().catch((e) => log.error({ err: e.message }, '[rotation.cron.fail]')),
  24 * 60 * 60 * 1000);
log.info('[vault.rotation.cron] daily rotation alert cron started');

// GET /api/vault/keys -> lista (mascarado, sem expor plain)
// FIX-WORKER-17 pass 12 + W4 pass 10: enriquece com error_stats_7d dos ultimos 7 dias.
// Usa W14 pass 7 idx_vault_usage_failures (partial WHERE success=FALSE) para LATERAL JOIN
// otimo. Sem este indice, query seq scan vault_key_usage (~70k+ rows/semana em prod ativo).
//
// Estrutura error_stats_7d por key:
//   { calls_7d: N, errors_7d: M, error_rate: M/N (0..1), last_error_at: T }
//
// Dashboard admin /admin/vault renderiza coluna "Saude 7d" baseado em error_rate:
//   - 0%: verde "OK"
//   - 1-5%: amarelo "Watch"
//   - >5%: vermelho "Issues"
//   - calls_7d=0: cinza "Idle" (chave nao usada)
// GET /api/vault/keys - lista keys admin (mascarado, sem plain_key)
// FIX-WORKER-7 pass 65: 5 BUGS aplicando Pattern W7 (Regras D+E + DLP + filters).
//
// BUG 1 *** Regra D TIEBREAKER MISSING *** ORDER BY created_at DESC sem id DESC
//   Keys provisionadas em burst (admin bulk provisioning + cron migration)
//   tem created_at identico -> ordem indefinida.
//   FIX: + k.id DESC tiebreaker.
//
// BUG 2 *** Regra E PAGINATION MISSING *** hardcoded LIMIT 200
//   Multi-seller scale (1000+ chaves) admin so vê 200 primeiras.
//   FIX: ?limit (1-200, default 50) + ?offset + total count.
//
// BUG 3 *** FILTERS MISSING *** UX painel sem segmentacao
//   Admin precisa filtrar: provider=openai, is_active=false, is_platform_pool=true
//   FIX: ?provider, ?is_active, ?is_platform_pool query params.
//
// BUG 4 *** DLP revoked_reason ***
//   revoked_reason eh texto livre admin escreveu. Padroes comuns:
//   "Chave vazada por joao.silva@email.com" (PII vazada no audit listing)
//   "Compromised, key sk-abc123def..." (key fingerprint preview vaza ADJACENTE)
//   "User reportou via Bearer XYZ" (token leak na rationale)
//   FIX: mask.text() em revoked_reason pre-response.
//
// BUG 5 *** CACHE MISSING ***
//   3 sub-queries vault_key_usage por row (N+1 amplificado). Mesmo com
//   idx_vault_usage_failures, 200 rows * 3 subqueries = 600 statements PG.
//   Cache 60s p/ admin dashboard refresh seguro (usage rate atualiza
//   eventualmente apos vault_key_usage INSERTs).
const keysListCacheKey = (req) => {
  const lim = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
  const off = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const prov = (req.query.provider || '').toString().toLowerCase();
  const act = req.query.is_active;
  const plat = req.query.is_platform_pool;
  return `vault:keys_list:lim=${lim}:off=${off}:p=${prov}:a=${act}:pl=${plat}`;
};

app.get('/keys',
  adminOnly,
  cache.cacheMiddleware(keysListCacheKey, 60),
  asyncHandler(async (req, res) => {
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

    // Filters
    const where = ['1=1'];
    const params = [];
    let i = 1;
    if (req.query.provider) {
      where.push(`k.provider = $${i++}`);
      params.push(String(req.query.provider).toLowerCase());
    }
    if (req.query.is_active != null) {
      where.push(`k.is_active = $${i++}`);
      params.push(String(req.query.is_active) === 'true');
    }
    if (req.query.is_platform_pool != null) {
      where.push(`k.is_platform_pool = $${i++}`);
      params.push(String(req.query.is_platform_pool) === 'true');
    }
    params.push(limit, offset);

    // FIX-WORKER-17 pass 180 (perf+security): refactor N+1 subqueries -> LEFT JOIN lateral.
    //
    // PRE-FIX (3 bugs):
    //   1. 3 correlated subqueries por row -> 50 keys = 150 sub-scans em vault_key_usage
    //      (tabela hot - cresce ~10k rows/dia). Listing admin lag visivel.
    //   2. COUNT separado em segunda query (2 round-trips PG).
    //   3. Cache key sem user context (admin-only OK, mas pre-fix p/ futuro tenant).
    //
    // POST-FIX:
    //   - Subquery agregada UNICA (LATERAL join) por key_id usando FILTER WHERE.
    //   - PG escaneia vault_key_usage 1 vez por key (vs 3x antes).
    //   - COUNT(*) OVER() window elimina segunda query.
    //   - Latencia: ~200ms (50 keys * 3 subscans) -> ~80ms (1 lateral scan).
    const r = await query(
      `SELECT k.id, k.seller_id, k.provider, k.key_alias, k.key_fingerprint,
              k.is_active, k.is_platform_pool,
              k.monthly_quota_usd_cents, k.usage_this_month_cents,
              k.expires_at, k.rotation_due_at, k.last_used_at,
              k.created_at, k.revoked_at, k.revoked_reason,
              COALESCE(u.calls_7d, 0)::INT AS calls_7d,
              COALESCE(u.errors_7d, 0)::INT AS errors_7d,
              u.last_error_at,
              COUNT(*) OVER()::INT AS _total
         FROM vault_api_keys k
         LEFT JOIN LATERAL (
           SELECT
             COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS calls_7d,
             COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days' AND success = FALSE) AS errors_7d,
             MAX(created_at) FILTER (WHERE success = FALSE) AS last_error_at
             FROM vault_key_usage WHERE vault_key_id = k.id
         ) u ON TRUE
         WHERE ${where.join(' AND ')}
         ORDER BY k.created_at DESC, k.id DESC
         LIMIT $${i++} OFFSET $${i++}`,
      params
    );

    const total = r.rows[0]?._total || 0;

    // Calcula error_rate + DLP mask revoked_reason + strip _total
    const keys = r.rows.map((k) => {
      const { _total, ...rest } = k;
      return {
        ...rest,
        revoked_reason: rest.revoked_reason ? mask.text(rest.revoked_reason) : null,
        error_rate: rest.calls_7d > 0 ? (rest.errors_7d / rest.calls_7d) : 0,
      };
    });

    res.json({
      keys,
      total,
      limit, offset,
      filters: {
        provider: req.query.provider || null,
        is_active: req.query.is_active != null ? String(req.query.is_active) === 'true' : null,
        is_platform_pool: req.query.is_platform_pool != null ? String(req.query.is_platform_pool) === 'true' : null,
      },
    });
  })
);

// POST /api/vault/use -> internal: outro svc pede chave para usar
// FIX SEG-VAULT-1: APENAS admin/staff OU header interno x-internal-token compativel com VAULT_INTERNAL_TOKEN
// Antes, qualquer JWT valido (incluindo buyer comum) podia chamar este endpoint e
// receber plain_key da pool da plataforma - vazamento critico.
// FIX-WORKER-7 pass 102: 3 BUGS adicionais (provider enum + audit + DLP fingerprint).
//
// BUG 5 *** PROVIDER ENUM WHITELIST MISSING ***
//   PRE-FIX: z.string() aceita 'openai; DROP TABLE...' (PG safe via $1 mas
//   provider='spoofed' bypassa pool filter e SELECT FOR UPDATE eh waste).
//   Tambem: SQL injection nao tecnico mas economic (atacante autenticado
//   tenta 1000 providers fake -> 1000 queries SELECT vault_api_keys).
//   FIX: enum whitelist (openai|anthropic|gemini|groq|asaas|evolution).
//
// BUG 6 *** Regra P AUDIT LOG MISSING ***
//   Vault /use retorna plain_key crypto secret. Compliance/forense REQUER trail
//   "quem pegou qual key, quando, why" para incident response (key leak suspect
//   -> investigar TODOS access do periodo).
//   PRE-FIX: log Pino apenas (pode ser deletado/rotated). audit_log eh DB
//   permanent + immutable trail.
//   FIX: INSERT audit_log atomic (best-effort - nao bloqueia plain_key release).
//   Payload: provider, seller_id, key_id, fingerprint (NUNCA plain_key).
//
// BUG 7 *** operation PARAM UNUSED ***
//   PRE-FIX: _operation destructured mas nunca usado. Pattern incompleto.
//   FIX: incluir operation no audit_log payload (qual LLM call: chat/embed/etc).
const VAULT_PROVIDER_ENUM = new Set([
  'openai','anthropic','gemini','groq','asaas','evolution','telegram','smtp'
]);

app.post('/use',
  useRateLimit,
  vaultUseGuard,
  validate({ body: z.object({
    provider: z.string().refine((p) => VAULT_PROVIDER_ENUM.has(p), {
      message: 'provider invalido. Allowed: ' + Array.from(VAULT_PROVIDER_ENUM).join(', '),
    }),
    seller_id: z.string().uuid().optional(),
    operation: z.string().max(60).optional(),
  }) }),
  asyncHandler(async (req, res, next) => {
    // FIX-WORKER-7 pass 24: 4 BUGS CRITICOS em endpoint que toca criptografia.
    //
    // BUG 1 *** SECURITY GRAVE *** SELECT * em vault_api_keys (2x!)
    //   Tabela contem encrypted_key + iv + auth_tag (AES-256-GCM secret material).
    //   SELECT * carrega TUDO no Node memory + transita PG wire protocol.
    //   Em crash/exception, stack trace pode vazar encrypted_key/iv/tag.
    //   Logs server (Pino) podem dump objeto inteiro em verbose mode.
    //   Pattern Regra I cross-svc CRITICO em endpoints toca crypto.
    //   FIX: SELECT explicit com 6 campos necessarios para decrypt+response.
    //   NUNCA mais campos via SELECT * (defense em profundidade vs vazamento).
    //
    // BUG 2 *** RACE POOL ALLOCATION (Regra K) ***
    //   Fallback pool platform: ORDER BY last_used_at NULLS FIRST.
    //   2 requests simultaneos (mesmo provider, sem seller_id) leem mesma key
    //   "menos usada" -> ambos pegam MESMA key. Load balancing QUEBRADO.
    //   Em providers com quota por key (OpenAI/Anthropic rate-limit per-key):
    //   - 1 key exhausted (429 from provider)
    //   - Outras keys idle (quota nao usada)
    //   - Plataforma "tem quota" mas usuario ve falha
    //   FIX: tx() + SELECT FOR UPDATE em pool fallback (lock atomico).
    //   Seller-specific NAO precisa lock (uma key por seller).
    //
    // BUG 3 UPDATE last_used_at separado da SELECT (race-residual)
    //   Pre-fix: SELECT -> decrypt -> UPDATE (3 queries lineares)
    //   Se UPDATE falhar (lock, network) apos retornar plain_key, last_used_at
    //   NAO atualizado -> proxima request ve essa key como "menos usada" again.
    //   Resultado: mesma key recebe sequencia infinita, outras idle.
    //   FIX: UPDATE dentro do MESMO tx() do pool. last_used_at atualiza com
    //   plain_key release atomicamente.
    //
    // BUG 4 ORDER BY tiebreaker faltando (Regra D)
    //   Pre-fix: ORDER BY last_used_at NULLS FIRST, created_at ASC
    //   2 keys nunca usadas (last_used_at NULL) + created_at ms identico
    //   (batch import) = ordem arbitraria PG planner.
    //   FIX: tiebreaker id (UUID sempre unique).
    const { provider, seller_id, operation } = req.body;

    // FIX bug 1: SELECT explicit p/ ambas queries (security: nunca SELECT *
    // em tabela com encrypted material).
    const KEY_FIELDS = `id, provider, encrypted_key, iv, auth_tag,
                        key_fingerprint, key_alias, is_platform_pool`;

    // 1. tenta seller-specific (sem race - uma key por seller normalmente)
    let r = seller_id ? await query(
      `SELECT ${KEY_FIELDS} FROM vault_api_keys
        WHERE provider = $1 AND seller_id = $2 AND is_active
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY created_at DESC, id LIMIT 1`,
      [provider, seller_id]
    ) : { rows: [] };

    // 2. fallback platform pool - REQUER FOR UPDATE (load balancing race)
    let k = r.rows[0];
    if (!k) {
      // FIX bug 2+3: tx() atomic - SELECT FOR UPDATE + UPDATE atomicos
      await tx(async (c) => {
        const poolR = await c.query(
          `SELECT ${KEY_FIELDS} FROM vault_api_keys
            WHERE provider = $1 AND is_platform_pool AND is_active
              AND (expires_at IS NULL OR expires_at > NOW())
            ORDER BY last_used_at NULLS FIRST, created_at ASC, id
            LIMIT 1
            FOR UPDATE SKIP LOCKED`,
          [provider]
        );
        if (poolR.rows.length) {
          k = poolR.rows[0];
          // UPDATE last_used_at DENTRO do tx() - garante atomicidade
          // FOR UPDATE SKIP LOCKED + UPDATE no MESMO tx() = serializacao
          // automatica entre requests concorrentes (cada uma pega DIFFERENT key).
          await c.query(
            'UPDATE vault_api_keys SET last_used_at = NOW(), last_used_ip = $1 WHERE id = $2',
            [req.ip, k.id]
          );
        }
      });
    } else {
      // Seller-specific path - UPDATE simples (sem race em uma key por seller)
      await query(
        'UPDATE vault_api_keys SET last_used_at = NOW(), last_used_ip = $1 WHERE id = $2',
        [req.ip, k.id]
      );
    }

    if (!k) return next(errorHandler.notFound('no_key_available'));

    let plain;
    try {
      plain = cryp.decrypt({ encrypted: k.encrypted_key, iv: k.iv, tag: k.auth_tag });
    } catch (e) {
      // FIX SEG-VAULT-2: nao vaza exception message ao cliente (DLP). Loga estruturado server-side.
      // Importante: NAO inclui k.encrypted_key/iv/tag no log (security).
      log.error({ err: e.message, key_id: k.id, fp: k.key_fingerprint }, '[vault.decrypt_fail]');
      return next(errorHandler.serverError('decrypt_failed'));
    }
    // FIX-WORKER-17 pass 230 (audit log ordering): res.json acontecia ANTES do
    // INSERT audit_log (sem await). Race conditions:
    //   1. Cliente derruba conexao -> Express cancela promise -> audit perdido
    //   2. DB transient fail -> log silencioso (catch swallow)
    //   3. Forense LGPD/SOC2: incident response key leak precisa trail garantido
    // POST-FIX: await + INSERT ANTES do res.json. Cliente recebe resposta apenas
    // apos trail gravado (+5-10ms p/ vault.use - operacao critica AES boundary).
    // .catch() preservado para nao quebrar response em case DB fail (audit gap
    // sera detectado por aiops monitoring de gap de audit_log entries).
    await query(
      `INSERT INTO audit_log
        (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
       VALUES ($1, $2, 'vault.use', 'vault_key', $3, 'info', $4::JSONB)`,
      [
        req.user?.sub || null,
        req.user?.role || (req.headers['x-internal-token'] ? 'internal' : 'unknown'),
        k.id,
        JSON.stringify({
          provider: k.provider,
          fingerprint: k.key_fingerprint,
          is_platform_pool: k.is_platform_pool,
          seller_id: seller_id || null,
          operation: operation || null,
          ip: req.ip,
        }),
      ]
    ).catch((e) => log.warn({ err: e.message, key_id: k.id }, '[vault.use.audit_fail]'));

    // POST-fix audit-first ordering: response apenas APOS trail gravado
    res.json({
      key_id: k.id, provider: k.provider, fingerprint: k.key_fingerprint, plain_key: plain,
      is_platform_pool: k.is_platform_pool, alias: k.key_alias,
    });

    // FIX-WORKER-17 pass 9: INSERT vault_key_usage REMOVIDO daqui.
    // Bug original: criava registro "fantasma" com cost_usd_cents=0 + success=TRUE
    // mesmo antes da chamada LLM ter ocorrido.
    // SOLUCAO: log autoritativo unico via POST /usage que tem o set completo
    // (cost, tokens, duration, success real, error_message).
  })
);

// POST /api/vault/keys/:id/revoke
// FIX-WORKER-7 pass 25: 5 BUGS GRAVES em endpoint critical security
// (revoga key crypto - forense + compliance + race).
//
// 1. UUID validation faltando -> 'abc' = PG 22P02 -> 500 generico
//    Pattern W4/W7 cross-svc consolidado.
//
// 2. *** RACE Regra K *** sem FOR UPDATE
//    2 admins revoke simultaneo: UPDATE concorrente (idempotente parcial -
//    is_active=FALSE OK mas revoked_reason sobrescreve last write wins).
//    Pior: /use concurrente em outra request pode SELECT key ANTES do
//    UPDATE chegar -> retorna plain_key + revoga LATER -> race vazamento.
//
// 3. *** IDEMPOTENCY BUG GRAVE *** WHERE id=$2 sem is_active check
//    Cenario forense catastrofico:
//    - 10:00 Admin A revoga key reason="leak suspected" -> revoked_at=10:00
//    - 10:00-14:00: forense iniciada, audit log externo registra incident
//    - 14:00 Admin B revoga MESMA key reason="rotation schedule" -> SOBRESCREVE
//    - DB agora diz: revoked_at=14:00, reason="rotation schedule"
//    - Forense 16:00 olha DB -> historico do incident 10:00 APAGADO
//    - Compliance issue critical: timeline forense corrompido
//    - Audit_log externo ainda tem record, mas DB <-> audit_log divergem
//    FIX: WHERE is_active = TRUE -> ROWCOUNT=0 se ja revogada -> 409 Conflict
//    com info "already_revoked_at" + reason original (preserva historico).
//
// 4. AUDIT_LOG missing - security event crit sem trail
//    Pattern W7 pass 23 (payouts) estabeleceu audit em real-money-out.
//    Revoke key crypto = sec event mesmo nivel (forense/compliance).
//    FIX: INSERT audit_log dentro do tx() (atomic with UPDATE).
//
// 5. RETURNING check missing -> client recebe {ok:true} mesmo se id valido
//    UUID mas nao existir no DB.
//    FIX: RETURNING id + 404 se rowcount=0.
const REVOKE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// FIX-WORKER-17 pass 236 (rate-limit revoke - DoS protection):
//   PRE-FIX: /keys/:id/revoke admin endpoint sem rate-limit. Cenario:
//   - Admin token vaza (XSS dashboard-admin, session hijack, OAuth pwn)
//   - Atacante itera vault_api_keys ids -> POST /revoke cada -> mass revoke
//   - Plataforma fica sem chaves LLM -> degraded mode prolongado
//   - Pattern V8: ALL endpoints write/mutate em vault precisam rate-limit
//   - /keys (provision) ja tem provisionRateLimit (5/min), revoke nao
//   POST-FIX: reuse provisionRateLimit (5 revogacoes/min e suficiente p/ ops
//   normal - operador manualmente revoga 1-2 keys/incident; 5/min protege
//   massive abuse). fail2ban global + rate-limit defesa em profundidade.
app.post('/keys/:id/revoke', provisionRateLimit, adminOnly,
  validate({ body: z.object({ reason: z.string().min(3).max(200) }) }),
  asyncHandler(async (req, res, next) => {
    if (!REVOKE_UUID_RE.test(req.params.id)) {
      return next(errorHandler.badRequest('invalid_uuid'));
    }

    // FASE 1 (tx atomic): lock + idempotent UPDATE + audit_log
    let outcome;
    await tx(async (c) => {
      // Lock pessimistico + verifica state ANTES de mutate
      const cur = await c.query(
        `SELECT id, is_active, revoked_at, revoked_reason, provider, key_alias, key_fingerprint
           FROM vault_api_keys
          WHERE id = $1::UUID
          FOR UPDATE`,
        [req.params.id]
      );
      if (!cur.rows.length) { outcome = { error: 'not_found' }; return; }
      const k = cur.rows[0];
      if (!k.is_active) {
        // Ja revogada - retorna 409 Conflict + info original (forense intact)
        outcome = {
          error: 'already_revoked',
          revoked_at: k.revoked_at,
          revoked_reason: k.revoked_reason,
        };
        return;
      }
      // Idempotent UPDATE (defense-in-depth - mesmo com FOR UPDATE acima)
      await c.query(
        `UPDATE vault_api_keys
            SET is_active = FALSE, revoked_at = NOW(), revoked_reason = $1
          WHERE id = $2::UUID AND is_active = TRUE`,
        [req.body.reason, req.params.id]
      );
      // Audit log no MESMO tx (atomic with UPDATE)
      await c.query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES ($1, $2, 'vault.revoke', 'vault_api_key', $3, 'warn', $4::JSONB)`,
        [req.user.sub, req.user.role, req.params.id,
         JSON.stringify({
           provider: k.provider,
           key_alias: k.key_alias,
           fingerprint: k.key_fingerprint,
           reason: req.body.reason,
           ip: req.ip,
         })]
      );
      outcome = { ok: true };
    });

    if (outcome?.error === 'not_found') {
      return next(errorHandler.notFound('key_not_found'));
    }
    if (outcome?.error === 'already_revoked') {
      // 409 Conflict - preserva timeline forense
      return res.status(409).json({
        error: 'already_revoked',
        message: 'Chave ja foi revogada anteriormente.',
        revoked_at: outcome.revoked_at,
        revoked_reason: outcome.revoked_reason,
      });
    }
    res.json({ ok: true });
  })
);

// FIX-WORKER-17 pass 13: POST /api/vault/keys/:id/rotate (swap 1-click).
//
// CONTEXTO:
// W17 pass 12 introduziu rotation_due_at + cron alerta. W4 pass 11 adicionou
// UI badge mas workflow manual: admin provisiona nova chave + revoga antiga
// em 2 etapas separadas. Janela vulneravel entre etapas se admin esquece de
// revogar = chave velha continua usavel.
//
// ESTE ENDPOINT: 1 click = swap atomico em tx() block:
// 1. SELECT antiga + lock (FOR UPDATE) - evita race com /use ou /revoke concorrente
// 2. INSERT nova com mesmo alias+provider+seller_id+is_platform_pool+quota
// 3. UPDATE antiga: is_active=FALSE, revoked_at=NOW, revoked_reason
// 4. Audit log INSERT (action='vault.rotate', old_key_id, new_key_id)
// 5. Commit
//
// REUSO contract /keys provision: novo registro tem rotation_due_at = NOW+90d
// (default), prazo fresh para nova chave.
//
// USE CASES:
// - Token expirando em 1d -> rotate antes do upstream revogar
// - Suspeita de leak (logs, ex-funcionario) -> rotate imediato
// - PCI rotation schedule -> rotate trimestral programado
// FIX-WORKER-17 pass 243 (revoked_reason overflow):
//   Schema vault_api_keys.revoked_reason VARCHAR(200). Rotate concatena
//   "rotated: ${reason} (-> ${uuid})" -> 9 + reason + 5 + 36 + 1 = 51+reason.
//   Reason max(200) -> total ate 251 chars -> PG 22001 string_too_long ->
//   tx rollback -> rotate FALHA + admin perplexo "validacao 200 chars passou
//   mas PG rejeita?". POST-FIX: reason max=140 garante total <=200 com
//   overhead "rotated: ... (-> uuid)".
const rotateSchema = z.object({
  plain_key: z.string().min(10).max(500),  // nova chave (FIX-WORKER-17 pass 254 max DoS)
  reason: z.string().min(3).max(140),  // motivo audit - 140 cabe c/ overhead em revoked_reason VARCHAR(200)
  rotation_days: z.number().int().min(1).max(365).optional(),  // novo prazo
});

app.post('/keys/:id/rotate',
  provisionRateLimit,
  adminOnly,
  validate({ body: rotateSchema }),
  asyncHandler(async (req, res, next) => {
    // PAYMENT_UUID_RE reusable para qualquer UUID
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(req.params.id)) {
      return next(errorHandler.badRequest('invalid_uuid'));
    }
    const { plain_key, reason, rotation_days } = req.body;
    const rotDays = rotation_days || 90;

    // Tx atomico: lock antiga + insert nova + revoke antiga + audit
    const result = await tx(async (c) => {
      const old = await c.query(
        `SELECT id, seller_id, provider, key_alias, is_platform_pool,
                monthly_quota_usd_cents, is_active
           FROM vault_api_keys
          WHERE id = $1::UUID
          FOR UPDATE`,
        [req.params.id]
      );
      if (!old.rows.length) return { error: 'not_found' };
      const o = old.rows[0];
      if (!o.is_active) return { error: 'already_revoked' };

      // Encripta nova chave (mesma logica de provision)
      const { encrypted, iv, tag } = cryp.encrypt(plain_key);
      const fp = cryp.sha256(plain_key).slice(0, 16);

      // INSERT nova com mesmos atributos (exceto encrypted_key+iv+tag+fp+rotation)
      const inserted = await c.query(
        `INSERT INTO vault_api_keys
           (seller_id, provider, key_alias, encrypted_key, iv, auth_tag, key_fingerprint,
            monthly_quota_usd_cents, is_platform_pool, rotation_due_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                 NOW() + ($10 || ' days')::INTERVAL)
         RETURNING id, key_fingerprint, rotation_due_at`,
        [o.seller_id, o.provider, o.key_alias, encrypted, iv, tag, fp,
         o.monthly_quota_usd_cents, o.is_platform_pool, String(rotDays)]
      );
      const newKey = inserted.rows[0];

      // Revoga antiga
      await c.query(
        `UPDATE vault_api_keys
            SET is_active = FALSE,
                revoked_at = NOW(),
                revoked_reason = $1
          WHERE id = $2`,
        [`rotated: ${reason} (-> ${newKey.id})`, o.id]
      );

      // Audit log
      await c.query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES ($1, $2, 'vault.rotate', 'vault_api_key', $3, 'warn', $4::JSONB)`,
        [req.user.sub, req.user.role, o.id,
         JSON.stringify({
           old_key_id: o.id,
           new_key_id: newKey.id,
           old_fingerprint: '<not_returned>',
           new_fingerprint: newKey.key_fingerprint,
           provider: o.provider,
           key_alias: o.key_alias,
           reason,
           rotation_days: rotDays,
           ip: req.ip,
         })]
      );

      return {
        ok: true,
        old_key_id: o.id,
        new_key_id: newKey.id,
        new_fingerprint: newKey.key_fingerprint,
        rotation_due_at: newKey.rotation_due_at,
      };
    });

    if (result.error === 'not_found') return next(errorHandler.notFound('key_not_found'));
    if (result.error === 'already_revoked') {
      return next(errorHandler.badRequest('already_revoked',
        'Chave ja foi revogada. Provisione uma nova via POST /keys (sem swap).'));
    }

    log.info({
      rotated_by: req.user.sub,
      old_key_id: result.old_key_id,
      new_key_id: result.new_key_id,
    }, '[vault.rotate]');
    res.json(result);
  })
);

// POST /api/vault/usage -> registra custo de uma chamada (faturar Classe B)
// FIX SEG-VAULT-3 (WORKER 17): endpoint usava jwt.requireAuth() sem role check
// -> qualquer buyer autenticado podia inflar usage_this_month_cents (DoS quota),
//    inserir registros falsos no vault_key_usage (poluicao audit) e atribuir
//    cobranca a outros seller_id (fraude billing).
// Agora exige header interno OU role admin/staff/service (mesmo guard do /use).
app.post('/usage', vaultUseGuard,
  validate({ body: z.object({
    key_id: z.string().uuid(),
    seller_id: z.string().uuid().optional(),
    product_id: z.string().uuid().optional(),
    operation: z.string(),
    model: z.string().optional(),
    tokens_input: z.number().int().nonnegative().optional(),
    tokens_output: z.number().int().nonnegative().optional(),
    cost_usd_cents: z.number().int().nonnegative(),
    duration_ms: z.number().int().nonnegative().optional(),
    success: z.boolean().default(true),
    error_message: z.string().optional(),
  })}),
  asyncHandler(async (req, res) => {
    const b = req.body;
    await query(
      `INSERT INTO vault_key_usage
        (vault_key_id, seller_id, product_id, operation, model, tokens_input, tokens_output,
         cost_usd_cents, duration_ms, success, error_message, ip_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [b.key_id, b.seller_id||null, b.product_id||null, b.operation, b.model||null,
       b.tokens_input||null, b.tokens_output||null, b.cost_usd_cents, b.duration_ms||null,
       b.success, b.error_message||null, req.ip]
    );
    await query(
      `UPDATE vault_api_keys SET usage_this_month_cents = usage_this_month_cents + $1 WHERE id = $2`,
      [b.cost_usd_cents, b.key_id]
    );
    res.json({ ok: true });
  })
);

// ============================================================
// FIX-WORKER-17 pass 217: SELLER BYOK SELF-SERVICE endpoints
// ============================================================
// Pre-pass-217: TODO endpoints vault-svc eram adminOnly. BYOK sellers
// dependiam de admin para provisionar/listar/revogar SUAS proprias keys.
// Bottleneck operacional: admin queue lotada com requests sellers.
//
// Post-pass-217: 3 endpoints seller self-service:
//   GET    /keys/me              - lista chaves do seller (sem encrypted_key leak)
//   POST   /keys/me              - provisiona chave para SUA loja
//   POST   /keys/me/:id/revoke   - revoga chave PROPRIA
//
// SECURITY HARDENING:
// - Ownership check via sellers.user_id = req.user.sub (JOIN strict)
// - SELECT NUNCA retorna encrypted_key/iv/auth_tag (apenas metadata + fingerprint)
// - Seller NAO pode setar is_platform_pool=true (so admin pode)
// - Provision rate-limit reused (provisionRateLimit existing)
// - Audit log INSERT em provision + revoke (forense seller-led changes)

// FIX-WORKER-17 pass 254 (plain_key DoS prevention):
//   PRE-FIX: plain_key z.string().min(10) sem upper bound. Atacante seller
//   poderia enviar 100MB string -> AES-256-GCM encrypt processa todo o
//   buffer em memoria -> svc OOM kill.
//   Real API keys tamanhos:
//     OpenAI sk-... ~51 chars, Anthropic sk-ant-... ~100, Gemini AIza... ~39
//     Groq gsk_... ~56, Cohere/Mistral similar. Custom max 500.
//   POST-FIX: .max(500) cobre todos providers + future + previne DoS.
//   Provision endpoint admin tambem fix (paridade).
const sellerKeyProvisionSchema = z.object({
  provider: z.enum(['openai','anthropic','gemini','groq','cohere','mistral','azure-openai','custom']),
  key_alias: z.string().min(3).max(100),
  plain_key: z.string().min(10).max(500),
  monthly_quota_usd_cents: z.number().int().positive().nullable().optional(),
  // Seller NUNCA pode setar is_platform_pool (so admin):
  // is_platform_pool: z.boolean()  REMOVED p/ seller schema
  expires_at: z.string().datetime().optional(),
  rotation_days: z.number().int().min(1).max(365).optional(),
});

// GET /api/vault/keys/me - lista chaves do seller logado (sem encrypted)
app.get('/keys/me', sellerOrAdmin, asyncHandler(async (req, res) => {
  // SECURITY: ownership via sellers.user_id (admin pode passar ?seller_id query)
  const isAdmin = req.user && ['admin','staff'].includes(req.user.role);
  const sellerFilter = isAdmin && req.query.seller_id ? req.query.seller_id : null;

  // Para seller: lookup sua proprio seller_id via sellers table
  let ownerSellerId;
  if (isAdmin && sellerFilter) {
    ownerSellerId = sellerFilter;
  } else {
    const s = await query('SELECT id FROM sellers WHERE user_id = $1', [req.user.sub]);
    if (!s.rows.length) return res.status(404).json({ error: 'seller_not_found' });
    ownerSellerId = s.rows[0].id;
  }

  // Explicit fields (NUNCA encrypted_key/iv/auth_tag - security):
  const r = await query(
    `SELECT id, provider, key_alias, key_fingerprint,
            is_active, monthly_quota_usd_cents, usage_this_month_cents,
            expires_at, rotation_due_at, last_used_at,
            created_at, revoked_at
       FROM vault_api_keys
      WHERE seller_id = $1
        AND is_platform_pool = FALSE
      ORDER BY created_at DESC, id ASC
      LIMIT 50`,
    [ownerSellerId]
  );
  res.json({ keys: r.rows, count: r.rows.length });
}));

// POST /api/vault/keys/me - seller provisiona SUA chave
app.post('/keys/me',
  provisionRateLimit,  // reuse limiter existente
  sellerOrAdmin,
  validate({ body: sellerKeyProvisionSchema }),
  asyncHandler(async (req, res, next) => {
    const isAdmin = req.user && ['admin','staff'].includes(req.user.role);
    // SECURITY: seller NUNCA pode setar is_platform_pool (force false)
    const isPlatformPool = false;

    let sellerId;
    if (isAdmin && req.body.seller_id) {
      sellerId = req.body.seller_id;
    } else {
      const s = await query('SELECT id FROM sellers WHERE user_id = $1', [req.user.sub]);
      if (!s.rows.length) return next(errorHandler.notFound('seller_not_found'));
      sellerId = s.rows[0].id;
    }

    const { provider, key_alias, plain_key, monthly_quota_usd_cents, expires_at, rotation_days } = req.body;
    const { encrypted, iv, tag } = cryp.encrypt(plain_key);
    const fp = cryp.sha256(plain_key).slice(0, 16);
    const rotDays = rotation_days || 90;

    const r = await query(
      `INSERT INTO vault_api_keys
         (seller_id, provider, key_alias, encrypted_key, iv, auth_tag, key_fingerprint,
          monthly_quota_usd_cents, is_platform_pool, expires_at, rotation_due_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW() + ($11 || ' days')::INTERVAL)
       RETURNING id, provider, key_alias, key_fingerprint, is_platform_pool,
                 monthly_quota_usd_cents, created_at, rotation_due_at`,
      [sellerId, provider, key_alias, encrypted, iv, tag, fp,
       monthly_quota_usd_cents || null, isPlatformPool, expires_at || null, String(rotDays)]
    );
    // Audit log seller-led action
    await query(
      `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
       VALUES ($1, $2, 'vault.seller_provision', 'vault_api_key', $3, 'info', $4::JSONB)`,
      [req.user.sub, req.user.role, r.rows[0].id,
       JSON.stringify({ provider, key_alias, fingerprint: fp, seller_id: sellerId, ip: req.ip })]
    ).catch(() => {});

    log.info({ provisioned: r.rows[0].id, provider, fp, seller_id: sellerId, by: req.user.sub },
      '[vault.seller_provision]');
    res.status(201).json(r.rows[0]);
  })
);

// POST /api/vault/keys/me/:id/revoke - seller revoga SUA chave
// FIX-WORKER-17 pass 240 (rate-limit parity seller revoke):
//   Pass 236 adicionou provisionRateLimit em /keys/:id/revoke (admin) mas
//   este endpoint SELLER ficou sem rate-limit. Account takeover scenario:
//   - Atacante hijack seller session (XSS dashboard-seller, OAuth pwn)
//   - Itera vault_api_keys WHERE seller_id=mine -> POST /keys/me/:id/revoke
//   - Sabotagem: todas keys BYOK do seller revogadas em segundos
//   - LLM features dependentes da BYOK chain quebram silently
//   POST-FIX: reuse provisionRateLimit (5/min). Sufficient p/ ops normal
//   (seller raramente revoga 5 keys/min) + bloqueia mass abuse.
app.post('/keys/me/:id/revoke',
  provisionRateLimit,
  sellerOrAdmin,
  validate({ body: z.object({ reason: z.string().min(3).max(500) }) }),
  asyncHandler(async (req, res, next) => {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(req.params.id)) {
      return next(errorHandler.badRequest('invalid_uuid'));
    }
    // SECURITY: ownership check - key.seller_id == seller.user_id == req.user.sub
    // Admin bypass: pode revogar qualquer key (via /keys/:id/revoke endpoint admin)
    const isAdmin = req.user && ['admin','staff'].includes(req.user.role);

    const r = await query(
      isAdmin
        ? `UPDATE vault_api_keys
              SET is_active = FALSE, revoked_at = NOW(), revoked_reason = $1
            WHERE id = $2 AND is_active = TRUE
            RETURNING id`
        : `UPDATE vault_api_keys
              SET is_active = FALSE, revoked_at = NOW(), revoked_reason = $1
            WHERE id = $2 AND is_active = TRUE
              AND seller_id IN (SELECT id FROM sellers WHERE user_id = $3)
            RETURNING id`,
      isAdmin ? [req.body.reason, req.params.id]
              : [req.body.reason, req.params.id, req.user.sub]
    );
    if (!r.rows.length) {
      return next(errorHandler.notFound('key_not_found_or_already_revoked'));
    }
    // Audit log
    await query(
      `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
       VALUES ($1, $2, 'vault.seller_revoke', 'vault_api_key', $3, 'warn', $4::JSONB)`,
      [req.user.sub, req.user.role, req.params.id,
       JSON.stringify({ reason: req.body.reason.slice(0, 200), ip: req.ip })]
    ).catch(() => {});

    res.json({ ok: true, revoked: r.rows[0].id });
  })
);

app.use((req, res) => res.status(404).json({ error: 'route_not_found' }));
app.use(errorHandler.errorMiddleware);

const server = app.listen(PORT, () => log.info({ port: PORT }, '[vault-svc] listening'));
['SIGINT','SIGTERM'].forEach((s) => process.on(s, () => server.close(() => process.exit(0))));
