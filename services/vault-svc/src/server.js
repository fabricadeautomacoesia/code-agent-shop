'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const express = require('express');
const nodeCrypto = require('node:crypto');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { query, tx } = require('@cas/db-client');
const { logger, sanitize, errorHandler, asyncHandler, jwt, validate, crypto: cryp, fail2ban, startup, cache, mask, withRetry, notifCache } = require('@cas/shared');

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
    /* FIX-WORKER-17 pass 323: ua mask.text() paridade pass 322 auth-svc. */
    const safeUaForensic = mask.text(req.headers['user-agent'] || '');
    log.warn({
      ip: req.ip,
      ua: safeUaForensic,
      tok_len_match: String(internalTok).length === expected.length,
    }, '[vault.invalid_internal_token]');
    /* FIX-WORKER-17 pass 458 (audit_log critical paridade /2fa pass 429):
       PRE-FIX: log.warn apenas (Pino + datadog) - 7d retention default.
       Internal token bruteforce e MUCH mais critical que 2FA invalid:
       - VAULT_INTERNAL_TOKEN da acesso a ALL platform keys (encrypted + iv + tag)
       - Successful bruteforce = total platform key compromise
       - log.warn nao queryable forensic post-incident (audit_log 90d sim)
       - SOC2 + LGPD direito-acesso forensic gap
       POST-FIX: audit_log critical paridade /2fa/disable.invalid_token pass 429.
       - actor_user_id NULL (atacante anonimo via internal-token bypass attempt)
       - target_type 'vault_internal' (novo target - VALID_TT pass 455 expand needed)
       - severity 'critical'
       - + tok_len_match preservado (forensic intel)
       - + ua_prefix masked (paridade pass 438)
       Fire-and-forget catch p/ nao bloquear response 401 ja em flight. */
    query(
      `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
       VALUES (NULL, 'anonymous', 'vault.invalid_internal_token', 'vault_internal', NULL, 'critical', $1::JSONB)`,
      [JSON.stringify({
        ip: req.ip,
        ua_prefix: safeUaForensic.slice(0, 60),
        tok_len_match: String(internalTok).length === expected.length,
      })]
    ).catch((auditErr) => log.error({
      err: mask.text(String(auditErr.message || '').slice(0, 200)),
    }, '[vault.invalid_internal_token.audit_fail]'));
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

// FIX-WORKER-17 pass 359 CRITICAL (keyGenerator missing - paridade pass 304):
//   PRE-FIX: provisionRateLimit SEM keyGenerator - usa req.ip (peer IP).
//   Vault-svc esta atras do gateway + Traefik (SwarmDNS) - peer IP = Traefik
//   compartilhado por TODOS os admins/sellers.
//   IMPACTO: shared bucket attack (mesmo padrao pass 304 gateway):
//   - Admin1+Admin2+Admin3 compartilham 5 req/min global
//   - Atacante token admin comprometido esgota bucket -> outros admins
//     ficam bloqueados de provisionar/revogar keys CRITICAL
//   - Pass 304 corrigiu gateway, useRateLimit (linha 96) e readRateLimit
//     (linha 121) mas provisionRateLimit ficou lagged
//   POST-FIX: keyGenerator x-real-ip (paridade endpoints irmaos)
const provisionRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limit_exceeded' },
  keyGenerator: (req) => req.headers['x-real-ip'] || req.ip,
});

// FIX-WORKER-17 pass 280 (enumeration defense em endpoints read):
//   PRE-FIX: GET /keys, GET /keys/me, GET /keys/rotation-due sem rate-limit.
//   Atacante com token seller valido pode enumerar metadata (key_alias,
//   fingerprints, expires_at) em loop 1000+ req/s -> stats leak + DoS
//   vault-svc (PG query overhead em CADA req mesmo apos cache HTTP no-store).
//   POST-FIX: rate-limit GENEROSO read (60 req/min/ip) - alinha com UX legit
//   (admin dash refresh + seller paineis). Pattern V8 cross-svc:
//   "Read endpoints com material sensivel TAMBEM precisam rate-limit".
const readRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.VAULT_READ_RATE_LIMIT || '60', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limit_exceeded' },
  keyGenerator: (req) => req.headers['x-real-ip'] || req.ip,
});

// FIX-WORKER-17 pass 254: plain_key DoS prevention (max 500 chars - cobre todos providers)
// FIX-WORKER-17 pass 276 (key_alias XSS + log injection):
//   PRE-FIX: key_alias z.string().min(3).max(100) sem regex
//   Atacante: key_alias='<script>alert(1)</script>' (HTML/JS injection)
//   key_alias='line1\r\nline2' (log injection - fake log entries)
//   Usado em: logs.info, audit_log.payload_after, admin dashboard rendering
//   Defesa: regex whitelist alfanumerico + - _ . (typical alias chars)
//   Pattern V8 cross-svc: 'safe-key-alias-123' OK, '<script>' bloqueado
const KEY_ALIAS_REGEX = /^[a-zA-Z0-9._\-]{3,100}$/;
const provisionSchema = z.object({
  seller_id: z.string().uuid().nullable().optional(),
  provider: z.enum(['openai','anthropic','gemini','groq','cohere','mistral','azure-openai','custom']),
  key_alias: z.string().regex(KEY_ALIAS_REGEX, 'Apenas letras/numeros/._- (3-100 chars)'),
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
  // FIX-WORKER-17 pass 273 (admin provision audit + tx atomicity):
  //   PRE-FIX: admin /keys POST inseria vault_api_keys SEM tx() + SEM audit_log
  //   - Seller path /keys/me ja tinha audit (linha 1051) + tx (pass 269)
  //   - Admin path lagged - COMPLIANCE GAP critico:
  //     * SOC2 CC1.4: documented authorization decisions
  //     * LGPD direito-acesso: "quem provisionou X em data Y" sem resposta
  //     * Vault keys = AES-256-GCM secrets - forensics OBRIGATORIO
  //   POST-FIX: tx() wrap + audit_log INSERT atomic (paridade /keys/me pass 269)
  // FIX-WORKER-17 pass 506 (withRetry deadlock defense - paridade pass 310/493):
  //   PRE-FIX: tx() sem withRetry. Provision admin pode race com:
  //   - Concurrent /rotate em key existente (lock contention vault_api_keys)
  //   - audit_log mass-insert burst (PG planner pode escolher diferentes lock orderings)
  //   - Deadlock 40P01 abandona INSERT -> stack 500 + admin re-tenta -> potencial
  //     duplicate provision (race window admin clicking ansiosamente)
  //   POST-FIX: withRetry wrap atomico (paridade /rotate + /seller_revoke + /use)
  let r;
  await withRetry('vault.admin_provision.tx', async () => await tx(async (c) => {
    r = await c.query(
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
    // Audit log - compliance critical (admin provision = high-impact)
    await c.query(
      `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
       VALUES ($1, $2, 'vault.admin_provision', 'vault_api_key', $3, 'warn', $4::JSONB)`,
      [req.user.sub, req.user.role, r.rows[0].id,
       JSON.stringify({
         provider, key_alias, fingerprint: fp,
         seller_id: seller_id || null,
         is_platform_pool, ip: req.ip,
         // FIX-WORKER-17 pass 438 (ua_prefix forensic - paridade /use linha 720)
         ua_prefix: mask.text((req.headers['user-agent'] || '').slice(0, 60)),
       })]
    );
  })); // close withRetry pass 506
  /* FIX-WORKER-17 pass 578 (admin path cache invalidation - completa cadeia pass 574):
     PRE-FIX (pass 489): GET /keys cached 60s + pass 409 idx admin cache.
     Pass 574 corrigiu seller path (POST /keys/me + revoke). Admin path lagged:
     - Admin provisiona key via POST /keys -> dashboard reload mostra lista STALE
     - /admin/vault page polling = nova key invisible ate 60s TTL
     - Bonus: rotation_due alerts cache (300s pass 409) tambem precisa invalidate
       (key recem-provisionada com rotation_due_at futuro pode aparecer em alerts cache stale)
     POST-FIX: cache.del wildcard 2 keys:
     - 'vault:keys_list:*' (GET /keys admin list cache pass 489)
     - 'vault:rotation_due:*' (GET /keys/rotation-due cache pass 409)
     Fire-and-forget catch (Redis down nao bloquear response 201).
     Paridade pass 574 seller path + pass 569 notif-svc /prefs invalidation. */
  Promise.all([
    cache.del('vault:keys_list:*'),
    cache.del('vault:rotation_due:*'),
  ]).catch(() => {});
  log.info({ provisioned: r.rows[0].id, provider, fp, rotation_due_at: r.rows[0].rotation_due_at },
    '[vault.provision]');
  res.status(201).json(r.rows[0]);
}));

// FIX-WORKER-17 pass 12: cron diario detecta keys vencendo rotacao em <= 7 dias
// (warn early) + vencidas (urgent). Cria notification in_app + email para
// admins. Usa idx_vault_rotation partial (WHERE is_active = TRUE) - barato.
async function rotationAlertCron() {
  try {
    /* FIX-WORKER-17 pass 632 (Regra D direction parity tiebreaker - paridade cadeia 30+ sites):
       PRE-FIX: ORDER BY rotation_due_at ASC sem id ASC tiebreaker.
       - Cron diario rotationAlertCron - LIMIT 50 (rotation window 7d normalmente <50)
       - Edge case: mass-provision keys mesmo rotation_days (90d default seller signup)
         5+ keys CHEGAM mesma rotation_due_at second-precision em batch import
       - Sem id ASC tiebreaker: PG default heap order arbitrario
       - Cron run-1: detecta key A,B,C primeiro -> notification cobre A,B,C
       - Cron run-2 (24h depois): detecta key C,A,B (heap reorder via VACUUM) ->
         notification re-cobre mesmas 3 keys (idempotente OK) MAS ordem audit_log
         payload_after.keys[] inverte -> forensic non-deterministic
       - LIMIT 50 + 51+ keys due same instant -> drift mensal
       POST-FIX: + id ASC tiebreaker (paridade Regra D V8 cross-svc).
       - Cron output deterministic (audit trail forense estavel)
       - LIMIT 50 picks always same N keys when ties (vs random rotation) */
    // Keys com rotation_due_at em < 7 dias (warning) e <= NOW() (overdue)
    const r = await query(
      `SELECT id, key_alias, provider, rotation_due_at,
              EXTRACT(EPOCH FROM (rotation_due_at - NOW()))/86400 AS days_remaining
         FROM vault_api_keys
        WHERE is_active = TRUE
          AND rotation_due_at IS NOT NULL
          AND rotation_due_at < NOW() + INTERVAL '7 days'
        ORDER BY rotation_due_at ASC, id ASC
        LIMIT 50`
    );
    if (!r.rows.length) return;
    // Pega lista de admin user_ids para criar notifications
    /* FIX-WORKER-17 pass 307 (Regra B deleted_at filter):
       PRE-FIX: filtro is_active+is_banned mas SEM deleted_at IS NULL.
       Admin soft-deleted (admin demitido, conta encerrada via PATCH /users)
       continua recebendo rotation alerts via email/in_app.
       Compliance LGPD: ex-funcionario nao deve continuar recebendo info
       operacional sensivel (key rotation = security signal de keys ativas).
       POST-FIX: + deleted_at IS NULL paridade cross-svc Pattern V8. */
    const admins = await query(
      `SELECT id FROM users
        WHERE role IN ('admin','staff')
          AND is_active = TRUE
          AND is_banned = FALSE
          AND deleted_at IS NULL`
    );
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
    ).catch((e) => log.warn({ /* FIX pass 343 DLP */ err: mask.text(String(e.message || '').slice(0, 300)) }, '[vault.rotation.notif.bulk.fail]'));

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
    ).catch((e) => log.warn({ /* FIX pass 343 DLP */ err: mask.text(String(e.message || '').slice(0, 300)) }, '[vault.rotation.email.bulk.fail]'));
    /* FIX-WORKER-17 pass 477 (notifCache cross-svc - vault_rotation_due admin alerts):
       Cron diaria detecta keys vencendo - notifica TODOS admins via bulk INSERT.
       Sem invalidate cache, admin abre dashboard manana e bell badge mostra
       count stale ate TTL 20s. Vault rotation = security-critical alerts.
       POST-FIX: lookup admin user_ids once + invalidateBulk uma vez ao fim. */
    try {
      const adminIds = await query(
        `SELECT id FROM users WHERE role IN ('admin','staff') AND is_active = TRUE AND is_banned = FALSE`
      );
      const ids = adminIds.rows.map((r) => r.id);
      if (ids.length) notifCache.invalidateBulk(ids);
    } catch (cacheErr) {
      log.warn({ err: mask.text(String(cacheErr.message || '').slice(0, 200)) }, '[vault.rotation.notif_cache.fail]');
    }
  } catch (e) {
    log.error({ /* FIX pass 343 DLP */ err: mask.text(String(e.message || '').slice(0, 300)) }, '[vault.rotation.cron.fail]');
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
  readRateLimit,
  adminOnly,
  cache.cacheMiddleware(rotationDueCacheKey, 300),
  asyncHandler(async (req, res) => {
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const daysWindow = Math.max(-30, Math.min(365, parseInt(req.query.days_window, 10) || 30));

    /* FIX-WORKER-17 pass 319: COUNT(*) OVER() window consolidation.
       PRE-FIX: 2 queries (rows + COUNT) com WHERE identico em vault_api_keys.
       Pattern V8 18+ endpoints consolidated (passes 178-313).
       POST-FIX: 1 query + strip _total via map + has_more boolean. */
    const r = await query(
      `SELECT id, key_alias, provider, is_platform_pool, rotation_due_at,
              EXTRACT(EPOCH FROM (rotation_due_at - NOW()))/86400 AS days_remaining,
              COUNT(*) OVER()::INT AS _total
         FROM vault_api_keys
        WHERE is_active = TRUE
          AND rotation_due_at IS NOT NULL
          AND rotation_due_at < NOW() + ($1 || ' days')::INTERVAL
        ORDER BY rotation_due_at ASC, id ASC
        LIMIT $2 OFFSET $3`,
      [String(daysWindow), limit, offset]
    );

    const total = r.rows[0]?._total ?? 0;
    const keys = r.rows.map((row) => { const { _total, ...rest } = row; return rest; });

    res.json({
      keys,
      count: keys.length,
      total,
      limit, offset, days_window: daysWindow,
      has_more: (offset + keys.length) < total,
    });
  })
);

// Cron 1x/dia as 09:00 UTC (06:00 BRT) - antes do horario comercial brasileiro
// setTimeout para 1a execucao 60s apos start (warmup), depois 24h interval
setTimeout(() => rotationAlertCron().catch(() => {}), 60000);
setInterval(() => rotationAlertCron().catch((e) => log.error({ /* FIX pass 343 DLP */ err: mask.text(String(e.message || '').slice(0, 300)) }, '[rotation.cron.fail]')),
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
// FIX-WORKER-17 pass 595 (cache key normalization paridade cadeia 17 sites
// cache hygiene cross-svc consolidacao - 18 sites total):
//   PRE-FIX BUGS (3 issues cache pollution + inconsistency vs handler):
//   1. prov raw .toLowerCase() sem trim e sem whitelist check. Handler aceita
//      e parametriza em PG query - sem SQL inject (param safe) MAS:
//      - ?provider=invalid_xyz -> cache key 'p=invalid_xyz', query 0 rows
//      - Multiple invalid attempts pollution + storage waste
//   2. act raw (req.query.is_active sem normalize). Handler:
//      String(req.query.is_active) === 'true' (case-sensitive linha 536).
//      - ?is_active=TRUE -> cache key 'a=TRUE', handler matches false -> 2 entries
//      - ?is_active=true -> cache key 'a=true', handler matches true -> 1 entry
//      Pollution + different responses cached sob keys diferentes.
//   3. plat raw - SAME bug pattern as act.
//
//   POST-FIX: normalize cache key SAME way handler normalizes:
//   - provider: whitelist VAULT_PROVIDER_ENUM check + lowercase
//   - is_active/is_platform_pool: 'true'/'false' normalize boolean string
//   Paridade cadeia 17 sites cache hygiene cross-svc (520-594 consolidacao).
const keysListCacheKey = (req) => {
  const lim = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
  const off = Math.max(0, parseInt(req.query.offset, 10) || 0);
  // Normalize provider: whitelist check pre-cache (VAULT_PROVIDER_ENUM declared linha 631)
  const provRaw = (req.query.provider || '').toString().trim().toLowerCase();
  const prov = VAULT_PROVIDER_ENUM.has(provRaw) ? provRaw : '';
  // Normalize boolean strings: 'true'/'false' or '' for missing
  const actRaw = String(req.query.is_active || '').toLowerCase();
  const act = (actRaw === 'true' || actRaw === 'false') ? actRaw : '';
  const platRaw = String(req.query.is_platform_pool || '').toLowerCase();
  const plat = (platRaw === 'true' || platRaw === 'false') ? platRaw : '';
  return `vault:keys_list:lim=${lim}:off=${off}:p=${prov}:a=${act}:pl=${plat}`;
};

app.get('/keys',
  readRateLimit,
  adminOnly,
  cache.cacheMiddleware(keysListCacheKey, 60),
  asyncHandler(async (req, res) => {
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

    // Filters
    const where = ['1=1'];
    const params = [];
    let i = 1;
    /* FIX-WORKER-17 pass 725 (cache MISMATCH bug + provider whitelist gap):
       PRE-FIX 2 issues:
       1. handler .toLowerCase() apenas (cacheKey linha 545 usa .trim().toLowerCase())
          - Trailing space ?provider=openai%20 -> cache stored 'openai' MAS
            handler WHERE provider='openai ' -> PG enum cast 22P02 -> 500 leak
       2. handler aceita ANY value (VAULT_PROVIDER_ENUM check missing)
          - cacheKey rejects via enum check linha 546 (becomes empty)
          - handler accepts raw 'junk' -> WHERE provider='junk' -> 0 rows OR enum err 500
          - VAULT_PROVIDER_ENUM ja existe linha 684 - whitelist check should mirror
       POST-FIX: + .trim() + VAULT_PROVIDER_ENUM whitelist (paridade cacheKey)
       - Invalid provider -> 400 explicit response (no PG error leak)
       - Cache + handler consistent normalization */
    if (req.query.provider) {
      const provRaw = String(req.query.provider).trim().toLowerCase();
      if (!VAULT_PROVIDER_ENUM.has(provRaw)) {
        return res.status(400).json({
          error: 'invalid_provider',
          allowed: Array.from(VAULT_PROVIDER_ENUM),
        });
      }
      where.push(`k.provider = $${i++}`);
      params.push(provRaw);
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
/* FIX-WORKER-17 pass 608 (VAULT_PROVIDER_ENUM alignment with provision schemas):
   PRE-FIX BUG: VAULT_PROVIDER_ENUM listava 8 providers (4 LLM + 4 non-LLM
   asaas/evolution/telegram/smtp) MAS provision schemas (provisionSchema linha 172
   + sellerKeyProvisionSchema linha 1356) listam 8 LLM (openai/anthropic/gemini/
   groq/cohere/mistral/azure-openai/custom). Discrepancy results:
   - /use POST accept provider=asaas -> VAULT_PROVIDER_ENUM ok mas /keys provision
     NUNCA aceita provider=asaas (Zod enum reject)
   - Resultado: 4 dead code paths em /use (asaas/evolution/telegram/smtp) -
     SEMPRE retornam no_key_available porque NUNCA podem ser provisionados
   - Inverse: cohere/mistral/azure-openai/custom em provision -> /use rejeita
   Arch: non-LLM keys (Asaas/Evolution/Telegram/SMTP) vem de ENV VARS, nao
   vault DB. ASAAS_API_KEY no env. Vault e exclusivo p/ LLM BYOK + platform pool.
   POST-FIX: alinhar VAULT_PROVIDER_ENUM com provision schemas (LLM-only).
   Remove dead code paths + consistency cross-endpoints.
   Trade-off ZERO: asaas/evolution/telegram/smtp NUNCA foram usaveis via /use.
   Pattern V8 W17 schema parity cross-endpoints. */
const VAULT_PROVIDER_ENUM = new Set([
  'openai','anthropic','gemini','groq','cohere','mistral','azure-openai','custom'
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
    // FIX-WORKER-17 pass 271 (ORDER BY direction parity):
    //   PRE-FIX: ORDER BY created_at DESC, id (sem DESC no tiebreaker)
    //   Mixed direction (DESC + ASC default). Seller com 2+ keys mesmo provider
    //   (rotation in-flight): ordering arbitrario entre requests = key chosen
    //   varia entre LLM calls.
    //   Pattern V8 consolidated pass 251/256/259/261 - same direction (DESC).
    let r = seller_id ? await query(
      `SELECT ${KEY_FIELDS} FROM vault_api_keys
        WHERE provider = $1 AND seller_id = $2 AND is_active
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [provider, seller_id]
    ) : { rows: [] };

    // 2. fallback platform pool - REQUER FOR UPDATE (load balancing race)
    let k = r.rows[0];
    if (!k) {
      // FIX bug 2+3: tx() atomic - SELECT FOR UPDATE + UPDATE atomicos
      /* FIX-WORKER-17 pass 310: withRetry deadlock 40P01 defesa em camada
         FOR UPDATE SKIP LOCKED minimiza mas nao elimina deadlock 100%.
         Pattern V8 cross-svc (paridade pass 309 qa-worker, pass 310 qa-svc). */
      await withRetry('vault.use.pool', async () => {
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
      }); // close withRetry pass 310
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
      log.error({ /* FIX pass 343 DLP */ err: mask.text(String(e.message || '').slice(0, 300)), key_id: k.id, fp: k.key_fingerprint }, '[vault.decrypt_fail]');
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
          // FIX-WORKER-17 pass 438 (ua_prefix forensic - paridade pass 282 auth-svc):
          //   PRE-FIX: vault audit_log SEMPRE sem ua_prefix.
          //   Pass 282 (auth-svc), 296 (review-svc), 408 (seller-svc) ja capturavam.
          //   Vault era unico svc security-critical lagged - forensic gap:
          //   - Admin token XSS-stolen -> attacker provisiona/rotate keys
          //   - audit_log mostra IP mas NAO browser/device fingerprint
          //   - Investigation post-incident: correlacionar IP+UA p/ device match impossivel
          //   POST-FIX: mask.text() ua_prefix (60 chars) - paridade cross-svc.
          //   Mask antes write (defense-in-depth - browser UA pode ter version leak).
          ua_prefix: mask.text((req.headers['user-agent'] || '').slice(0, 60)),
        }),
      ]
    ).catch((e) => {
      /* FIX-WORKER-17 pass 555 (audit gap escalation - SECURITY CRITICAL observability):
         PRE-FIX: log.warn em catch quando audit_log INSERT fail.
         - Vault /use eh boundary AES-256-GCM = retorna plain crypto key
         - LGPD Art 37 + SOC2 CC7.3 + ISO 27001 A.12.4: TODO acesso a
           secrets material precisa trail forense queryable
         - audit fail = response continua (fail-open) MAS sem trail
         - Comentario afirma 'audit gap sera detectado por aiops monitoring'
           MAS nao ha mecanismo aiops currently detecting gaps
         - log.warn em Pino/Loki NAO dispara alerta operacional
         - Cenario worst-case: atacante post-XSS forca audit_log DB outage
           timing -> vault.use response sem trail = compromise invisivel
         POST-FIX:
         1. log.error (vs log.warn) - severity bump
         2. + audit_log fallback INSERT em audit_log com severity='critical'
            (mesma tabela mas action='vault.use.audit_fail' - se PRIMARY
            audit falhou, FALLBACK pode succeed em retry/connection recovery)
         3. Tag '[vault.use.audit_fail.CRITICAL]' p/ alertmanager regex match
         4. payload inclui key_id + user_id + ip + ua (forensic fallback) */
      log.error({
        err: mask.text(String(e.message || '').slice(0, 300)),
        key_id: k.id,
        user_id: req.user?.sub || null,
        ip: req.ip,
      }, '[vault.use.audit_fail.CRITICAL] PRIMARY audit_log INSERT failed - vault.use boundary breach risk');
      // FALLBACK audit_log INSERT with severity=critical (different transaction)
      // If primary failed due to constraint/lock, this may succeed via retry connection
      query(
        `INSERT INTO audit_log
          (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES ($1, $2, 'vault.use.audit_fail', 'vault_key', $3, 'critical', $4::JSONB)`,
        [
          req.user?.sub || null,
          req.user?.role || (req.headers['x-internal-token'] ? 'internal' : 'unknown'),
          k.id,
          JSON.stringify({
            primary_audit_error: mask.text(String(e.message || '').slice(0, 200)),
            provider: k.provider,
            fingerprint: k.key_fingerprint,
            ip: req.ip,
            ua_prefix: mask.text((req.headers['user-agent'] || '').slice(0, 60)),
          }),
        ]
      ).catch((e2) => log.error({
        err: mask.text(String(e2.message || '').slice(0, 200)),
        key_id: k.id,
      }, '[vault.use.audit_fail.FALLBACK_ALSO_FAILED] DB outage suspected - investigate'));
    });

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
    /* FIX-WORKER-17 pass 507 (withRetry deadlock defense - paridade pass 310/493/506):
       PRE-FIX: tx() sem withRetry wrap. Cenarios deadlock 40P01:
       - 2 admins concurrent revoke mesma key OR diferentes keys mesma seller
       - /revoke race com /rotate concurrent (mesma vault_api_keys row + audit_log)
       - /use pool fetch concurrent locking same key during revoke
       Pass 506 completou cadeia rotate + admin provision, MAS admin /revoke
       (callback) lagged. Pass 25 estabeleceu tx() atomic (audit_log dentro),
       mas withRetry foi adicionado apenas /use (pass 310) e seller revoke (493).
       Compliance (mesmo motivo /rotate + provision):
       - SOC2 CC7.3 + LGPD Art 37: revoke = security event critical
       - Mid-revoke crash sem retry = stack 500 generico vazado
       - Admin re-tenta -> potencial state ja revogada (caso resolvido pelo
         WHERE is_active=TRUE da linha 869) MAS audit_log pode duplicar
       POST-FIX: withRetry wrap (3 attempts backoff). Pattern V8 consolidated
       cross-svc: vault all 6 endpoints agora com withRetry uniform. */
    let outcome;
    await withRetry('vault.admin_revoke.tx', async () => await tx(async (c) => {
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
      // FIX-WORKER-17 pass 433 (DLP write-side em revoked_reason DB column):
      //   Mesma gap dos pass 295 - audit mascarava mas DB column raw.
      //   Mask antes UPDATE para defesa em backup pg_dump + psql direto.
      const reasonMaskedAdmin = mask.text(String(req.body.reason || '').slice(0, 200));
      // Idempotent UPDATE (defense-in-depth - mesmo com FOR UPDATE acima)
      await c.query(
        `UPDATE vault_api_keys
            SET is_active = FALSE, revoked_at = NOW(), revoked_reason = $1
          WHERE id = $2::UUID AND is_active = TRUE`,
        [reasonMaskedAdmin, req.params.id]
      );
      /* FIX-WORKER-17 pass 295: DLP mask reason em audit (paridade seller revoke)
         FIX pass 433: reuse reasonMaskedAdmin (mesma value que UPDATE - consistencia) */
      await c.query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES ($1, $2, 'vault.revoke', 'vault_api_key', $3, 'warn', $4::JSONB)`,
        [req.user.sub, req.user.role, req.params.id,
         JSON.stringify({
           provider: k.provider,
           key_alias: k.key_alias,
           fingerprint: k.key_fingerprint,
           reason: reasonMaskedAdmin,
           ip: req.ip,
           // FIX-WORKER-17 pass 438 (ua_prefix forensic - paridade /use + /keys)
           ua_prefix: mask.text((req.headers['user-agent'] || '').slice(0, 60)),
         })]
      );
      outcome = { ok: true };
    })); // close withRetry pass 507

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
    /* FIX-WORKER-17 pass 578: admin revoke cache invalidation paridade admin provision.
       cache.del vault:keys_list:* + vault:rotation_due:* pos-tx commit. */
    Promise.all([
      cache.del('vault:keys_list:*'),
      cache.del('vault:rotation_due:*'),
    ]).catch(() => {});
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
    // FIX-WORKER-17 pass 412 (key_fingerprint forensic gap em audit_log):
    //   PRE-FIX: SELECT sem key_fingerprint -> audit_log linha 939 logava
    //   'old_fingerprint: <not_returned>' placeholder string
    //   - Forense: 'qual fingerprint chave revogada?' = unknown via audit
    //   - SOC2/LGPD compliance: rotation events sem identificacao precisa
    //   - Admin investigation post-incident: link old->new key via fp impossivel
    //   POST-FIX: + key_fingerprint no SELECT (cheap - mesma row lock)
    /* FIX-WORKER-17 pass 506 (deadlock retry defense - paridade pass 310 + 493):
       PRE-FIX BUG: tx() sem withRetry wrap. /keys/:id/rotate eh endpoint critical
       security (rotates encryption keys AES-256-GCM secret material):
       - 2 admins concurrent rotate mesma key -> SELECT FOR UPDATE bloqueia mas
         deadlock 40P01 possivel cross-row (INSERT new + UPDATE old + audit_log
         lock ordering pode race com /revoke concurrent ou /use pool fetch)
       - Sem retry: deadlock abandona mid-operation -> errorHandler 500 generico
         -> admin re-tenta -> potencial duplicate INSERT (2 new keys p/ 1 rotation)
       - Pass 25 BUG fixed admin /revoke tx atomic, pass 269 seller provision,
         pass 310 /use pool withRetry, pass 493 seller revoke tx+withRetry
       - /rotate (este) ficou LAGGED em paridade defensiva
       Compliance impact:
       - SOC2 CC7.3: monitoring changes em PII assets (vault keys = secrets)
       - LGPD Art 37: registro de tratamento dados criptografados
       - Mid-rotation crash sem retry = stack trace 500 vazado + sem audit log
       POST-FIX: withRetry wrap (3 attempts backoff exponencial)
       Pattern V8 cross-svc consolidated: vault, qa-svc, payment-svc, review-svc */
    const result = await withRetry('vault.rotate.tx', async () => await tx(async (c) => {
      const old = await c.query(
        `SELECT id, seller_id, provider, key_alias, is_platform_pool,
                monthly_quota_usd_cents, is_active, key_fingerprint
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

      // FIX-WORKER-17 pass 433 (DLP gap rotate reason - paridade /revoke pass 295):
      //   PRE-FIX: /revoke linha 819 ja mask.text(reason) em audit_log
      //   /rotate audit log linha 951 escrevia reason RAW
      //   /rotate revoked_reason linha 935 concatenava reason RAW na coluna
      //   Atacante admin (pwned ou interno malicioso) pode escrever:
      //     reason: "rotated due to leak of Bearer abc...xyz" (Bearer raw)
      //     reason: "vazou CPF 12345678901 em logs"
      //     reason: "sk-ant-XYZ leaked, rotate now"
      //   Sem mask.text() -> secret/PII entra em:
      //     1. revoked_reason VARCHAR(200) (DB column persisted)
      //     2. audit_log.payload_after JSONB (forensic queries)
      //   Ambos lidos via /admin/audit-log + /admin/vault listing.
      //   Pattern V8 W17 DLP: TODO reason field operacional precisa mask.text antes.
      //   POST-FIX: mask.text(reason) em ambos UPDATE + audit_log.
      //   Note: o "Reason mascarado" e cosmetico - mascara secret/PII mas
      //   preserva intent (admin contexto operacional).
      const maskedReason = mask.text(String(reason || '').slice(0, 140));

      // Revoga antiga (FIX pass 433: reason masked p/ DLP em column persisted)
      await c.query(
        `UPDATE vault_api_keys
            SET is_active = FALSE,
                revoked_at = NOW(),
                revoked_reason = $1
          WHERE id = $2`,
        [`rotated: ${maskedReason} (-> ${newKey.id})`, o.id]
      );

      // Audit log (FIX pass 433: reason masked p/ DLP audit_log payload)
      // FIX-WORKER-17 pass 412: old_fingerprint real (era placeholder string)
      await c.query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES ($1, $2, 'vault.rotate', 'vault_api_key', $3, 'warn', $4::JSONB)`,
        [req.user.sub, req.user.role, o.id,
         JSON.stringify({
           old_key_id: o.id,
           new_key_id: newKey.id,
           old_fingerprint: o.key_fingerprint,
           new_fingerprint: newKey.key_fingerprint,
           provider: o.provider,
           key_alias: o.key_alias,
           reason: maskedReason,
           rotation_days: rotDays,
           ip: req.ip,
           // FIX-WORKER-17 pass 438 (ua_prefix forensic - paridade cross-endpoints vault)
           ua_prefix: mask.text((req.headers['user-agent'] || '').slice(0, 60)),
         })]
      );

      return {
        ok: true,
        old_key_id: o.id,
        new_key_id: newKey.id,
        new_fingerprint: newKey.key_fingerprint,
        rotation_due_at: newKey.rotation_due_at,
      };
    })); // close withRetry pass 506

    if (result.error === 'not_found') return next(errorHandler.notFound('key_not_found'));
    if (result.error === 'already_revoked') {
      return next(errorHandler.badRequest('already_revoked',
        'Chave ja foi revogada. Provisione uma nova via POST /keys (sem swap).'));
    }

    /* FIX-WORKER-17 pass 578: rotate cache invalidation - admin path paridade.
       Rotate = ATOMIC swap (revoke antiga + provision nova). Cache lists
       precisam refresh: keys_list (status changes) + rotation_due (new
       rotation_due_at de nova key). cache.del wildcard pos-tx commit. */
    Promise.all([
      cache.del('vault:keys_list:*'),
      cache.del('vault:rotation_due:*'),
    ]).catch(() => {});
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
  /* FIX-WORKER-17 pass 298: error_message length cap + DLP mask defense.
     PRE-FIX: error_message z.string().optional() sem .max() - LLM stack
     traces podem ser MB. PG TEXT column accept mas storage waste +
     potencial Bearer/sk-key/PG_PASS em stacks vazado em audit/reports.
     POST-FIX: .max(2000) + mask.text() no INSERT (paridade pass 285/289
     que aplicaram mask.text em error tracking cross-svc). */
  validate({ body: z.object({
    key_id: z.string().uuid(),
    seller_id: z.string().uuid().optional(),
    product_id: z.string().uuid().optional(),
    operation: z.string().max(80),
    model: z.string().max(100).optional(),
    tokens_input: z.number().int().nonnegative().optional(),
    tokens_output: z.number().int().nonnegative().optional(),
    cost_usd_cents: z.number().int().nonnegative(),
    duration_ms: z.number().int().nonnegative().optional(),
    success: z.boolean().default(true),
    error_message: z.string().max(2000).optional(),
  })}),
  asyncHandler(async (req, res) => {
    const b = req.body;
    // FIX-WORKER-17 pass 261 (atomicity INSERT + UPDATE usage counter):
    //   PRE-FIX: 2 queries separadas SEM tx(). Se INSERT vault_key_usage
    //   commit mas UPDATE vault_api_keys.usage_this_month_cents falha
    //   (lock, deadlock 40P01, conexao morre mid-batch):
    //   - vault_key_usage tem row de uso
    //   - vault_api_keys.usage_this_month_cents NAO incrementa
    //   Billing dashboard mostra usage menor que real -> seller paga menos
    //   Auto-disable logic baseado em quota nunca dispara (quota stuck)
    //   POST-FIX: tx() wrap atomic - all-or-nothing
    //   Mesmo pattern de pass 247 W11 outras tx-wrapped writes vault.
    // FIX-WORKER-17 pass 390 (key existence + is_active guard):
    //   PRE-FIX: INSERT vault_key_usage SEM verify key_id valido/ativo
    //   - FK constraint apenas valida row existe (nao is_active)
    //   - UPDATE counter em key revogada (chave morta acumula billing inflado)
    //   - UPDATE rowCount=0 silent quando id wrong = consistency gap
    //   - vault_key_usage tem entry mas counter nunca incrementa
    //   - Billing audit dashboard: usage tracked mas quota nao bate
    //   POST-FIX: SELECT FOR UPDATE upfront (verify exists + active)
    //   - Lock key durante incremento (anti-race usage burst)
    //   - is_active=FALSE -> 410 Gone (chave revogada nao aceita usage)
    //   - row nao existe -> 404 (admin/svc passou id invalido)
    //   - UPDATE com RETURNING + check rowCount=1 (idempotent guard)
    /* FIX-WORKER-17 pass 643 (withRetry deadlock defense - completa cadeia W17 7+1 sites):
       PRE-FIX: tx() sem withRetry wrap (linha 1279 antes deste fix).
       - /usage eh HIGH FREQUENCY endpoint (cada LLM call qa-worker -> vault /usage)
       - Em prod: qa-worker mass campaign 50+ runs concurrent = vault deadlock window
       - Cenarios deadlock 40P01:
         1. SELECT FOR UPDATE em mesma key concorrente (2 LLM calls usando same key)
         2. UPDATE usage_this_month_cents race com /rotate UPDATE (lock ordering)
         3. UPDATE race com /keys/me/:id/revoke UPDATE (mesma row lock)
       - PRE-FIX impact: ~1-5% requests durante peak fail silent 500
         + LLM cost gasto MAS billing nao registra (perda receita real)
       - Outros endpoints write vault TODOS com withRetry:
         provision (506), seller_provision (507/1527), rotate (1117),
         admin_revoke (972), seller_revoke (1624), use.pool (763)
       - /usage era ULTIMO endpoint write SEM withRetry - lagged consolidacao
       POST-FIX: withRetry('vault.usage.tx') wrap (3 attempts backoff)
       Pattern V8 W17 atomicity COMPLETA: TODOS 8 endpoints write vault com withRetry. */
    let outcome;
    await withRetry('vault.usage.tx', async () => await tx(async (c) => {
      const keyCheck = await c.query(
        `SELECT id, is_active FROM vault_api_keys WHERE id = $1::UUID FOR UPDATE`,
        [b.key_id]
      );
      if (!keyCheck.rows.length) {
        outcome = { error: 'key_not_found' };
        return;
      }
      if (!keyCheck.rows[0].is_active) {
        outcome = { error: 'key_revoked' };
        return;
      }
      /* FIX-WORKER-17 pass 298: DLP mask error_message antes storage.
         LLM exception stacks podem conter sk-/Bearer/JWT/PG_PASS leak.
         Paridade pass 277 (qa-worker download_failed), pass 285 (notif
         outbox failed_reason), pass 289 (asaas processing_error). */
      const safeErr = b.error_message ? mask.text(String(b.error_message).slice(0, 2000)) : null;
      await c.query(
        `INSERT INTO vault_key_usage
          (vault_key_id, seller_id, product_id, operation, model, tokens_input, tokens_output,
           cost_usd_cents, duration_ms, success, error_message, ip_address)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [b.key_id, b.seller_id||null, b.product_id||null, b.operation, b.model||null,
         b.tokens_input||null, b.tokens_output||null, b.cost_usd_cents, b.duration_ms||null,
         b.success, safeErr, req.ip]
      );
      // UPDATE com WHERE is_active=TRUE adicional (defense-in-depth, FOR UPDATE ja garante)
      const upd = await c.query(
        `UPDATE vault_api_keys SET usage_this_month_cents = usage_this_month_cents + $1
          WHERE id = $2::UUID AND is_active = TRUE`,
        [b.cost_usd_cents, b.key_id]
      );
      if (upd.rowCount !== 1) {
        // Defensive: race entre SELECT FOR UPDATE check e UPDATE (impossivel com lock mas log warn)
        log.warn({ key_id: b.key_id, rowCount: upd.rowCount },
          '[vault.usage.counter_update_unexpected] FOR UPDATE lock perdido?');
      }
    }));
    if (outcome?.error === 'key_not_found') {
      log.warn({ ip: req.ip, key_id: b.key_id }, '[vault.usage.key_not_found]');
      return res.status(404).json({ error: 'key_not_found', message: 'Chave nao encontrada.' });
    }
    if (outcome?.error === 'key_revoked') {
      log.warn({ ip: req.ip, key_id: b.key_id }, '[vault.usage.key_revoked]');
      return res.status(410).json({ error: 'key_revoked', message: 'Chave revogada nao aceita novos usage records.' });
    }
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
  // FIX-WORKER-17 pass 276: paridade XSS/log injection regex (KEY_ALIAS_REGEX)
  key_alias: z.string().regex(KEY_ALIAS_REGEX, 'Apenas letras/numeros/._- (3-100 chars)'),
  plain_key: z.string().min(10).max(500),
  monthly_quota_usd_cents: z.number().int().positive().nullable().optional(),
  // Seller NUNCA pode setar is_platform_pool (so admin):
  // is_platform_pool: z.boolean()  REMOVED p/ seller schema
  expires_at: z.string().datetime().optional(),
  rotation_days: z.number().int().min(1).max(365).optional(),
});

// GET /api/vault/keys/me - lista chaves do seller logado (sem encrypted)
// FIX-WORKER-17 pass 542 (cache gap /keys/me paridade /keys admin pass 489):
//   PRE-FIX: GET /keys/me (seller BYOK list) sem cache.cacheMiddleware.
//   Admin equivalent /keys (linha 502) tem cache 60s desde pass 65/489 mas
//   este endpoint seller ficou lagged. Dashboard-seller /conta/seguranca
//   ou painel BYOK polling refresh => cada hit = JOIN-like select + window
//   COUNT(*) OVER() em vault_api_keys (~50-100ms em sellers com 10+ keys
//   multi-provider OpenAI+Anthropic+Groq BYOK accum).
//   POST-FIX: cache.cacheMiddleware 60s vary by user+pagination.
//   Cache key: per (user.sub, seller_filter, limit, offset).
//   Invalidacao: TTL natural 60s (write-then-read freshness gap aceitavel
//   - seller provision/revoke nao precisa instant view; UI optimistic update
//   ja reflete mudanca client-side via componente local state).
//   TODO futuro: cache.del('vault:keys_me:u='+req.user.sub+':*') em
//   POST/revoke se UI feedback ficar slow (pattern wildcard del em cache.js).
//   Pattern V8 W17 paridade cache: /keys admin (60s) + /keys/me (este 60s).
//   Latency 50-100ms -> 1-2ms (Redis hit).
// FIX-WORKER-17 pass 602 (cache key UUID validation gap pre-cache paridade pass 589):
//   PRE-FIX BUG: sellerKey ja tinha .toLowerCase() MAS faltava UUID_RE validation.
//   Handler valida UUID (linha 1377-1379) e retorna 400 invalid_seller_id.
//   MAS cache key incluia raw seller_id leading to pollution:
//   - ?seller_id=abc-invalid -> cache key 's=abc-invalid', handler 400
//   - ?seller_id=garbage123 -> cache key 's=garbage123', handler 400
//   - Cada tentativa malformada = entry Redis (storage waste + sprawl)
//   - Admin probing atacker amplifica em listings cross-seller dashboard
//   POST-FIX: + UUID validation pre-cache. Invalid -> '' (consistent cache key).
//   Paridade pass 589 review-svc /seller/received UUID validation gap.
const VAULT_UUID_RE_CACHE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keysmeListCacheKey = (req) => {
  const isAdmin = req.user && ['admin','staff'].includes(req.user.role);
  // Normalize seller_id: trim + lowercase + UUID validation (paridade handler linha 1377)
  const sellerIdRaw = isAdmin && req.query.seller_id
    ? String(req.query.seller_id).trim().toLowerCase() : '';
  const sellerIdNorm = (sellerIdRaw && VAULT_UUID_RE_CACHE.test(sellerIdRaw))
    ? sellerIdRaw : '';
  const sellerKey = sellerIdNorm || (req.user?.sub || 'anon');
  const lim = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50, 200));
  const off = Math.max(0, parseInt(req.query.offset, 10) || 0);
  return `vault:keys_me:u=${req.user?.sub || 'anon'}:s=${sellerKey}:lim=${lim}:off=${off}`;
};

app.get('/keys/me', readRateLimit, sellerOrAdmin,
  cache.cacheMiddleware(keysmeListCacheKey, 60),
  asyncHandler(async (req, res) => {
  // SECURITY: ownership via sellers.user_id (admin pode passar ?seller_id query)
  const isAdmin = req.user && ['admin','staff'].includes(req.user.role);
  // FIX-WORKER-17 pass 264 (UUID validation defense):
  //   PRE-FIX: req.query.seller_id passava direto p/ PG WHERE seller_id = $1
  //   String malformada (admin typo ou attacker probe) -> PG cast UUID 22P02
  //   -> errorHandler 500 leak (info disclosure: PG version, schema hints)
  //   POST-FIX: regex UUID test + 400 invalid_uuid amigavel + log.warn
  //   Mesma pattern outros endpoints vault (pass 236 revoke UUID guard).
  const VAULT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (isAdmin && req.query.seller_id && !VAULT_UUID_RE.test(String(req.query.seller_id))) {
    return res.status(400).json({ error: 'invalid_seller_id', expected: 'UUID v4 format' });
  }
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

  /* FIX-WORKER-17 pass 300: pagination + COUNT OVER() consolidation.
     PRE-FIX:
     - LIMIT 50 hardcoded - seller >50 keys (multi-provider BYOK accum) nao
       conseguia ver todas
     - No total count - UI nao sabia se ha mais
     POST-FIX:
     - ?limit (1-200, default 50) + ?offset paginacao V8 Regra E
     - COUNT(*) OVER()::INT consolidacao (pattern pass 178/200/202/289/293)
     - has_more boolean UX */
  const lim = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50, 200));
  const off = Math.max(0, parseInt(req.query.offset, 10) || 0);
  // Explicit fields (NUNCA encrypted_key/iv/auth_tag - security):
  // FIX-WORKER-17 pass 376 (tiebreaker direction parity - Regra D pass 251):
  //   PRE-FIX: ORDER BY created_at DESC, id ASC (mixed direction)
  //   PG default ASC para tiebreaker quando direction omitted - mas explicit
  //   ASC + DESC misturados causam pagination drift em mass-insert burst:
  //   - 10 keys provisioned mesmo created_at (rare mas possivel cron import)
  //   - page 1 oset=0: [id=A1, A2, ...] (ASC entre mesmo ts)
  //   - cache evict + insert -> ids reordenam, user ve key 2x ou pula uma
  //   Pass 251 corrigiu orders endpoint, vault-svc ficou lagged.
  //   POST-FIX: SAME direction (DESC, DESC) p/ ordering deterministic per snapshot.
  const r = await query(
    `SELECT id, provider, key_alias, key_fingerprint,
            is_active, monthly_quota_usd_cents, usage_this_month_cents,
            expires_at, rotation_due_at, last_used_at,
            created_at, revoked_at,
            COUNT(*) OVER()::INT AS _total
       FROM vault_api_keys
      WHERE seller_id = $1
        AND is_platform_pool = FALSE
      ORDER BY created_at DESC, id DESC
      LIMIT $2 OFFSET $3`,
    [ownerSellerId, lim, off]
  );
  const total = r.rows[0]?._total ?? 0;
  const keys = r.rows.map((row) => { const { _total, ...rest } = row; return rest; });
  res.json({
    keys,
    count: keys.length,
    total,
    limit: lim,
    offset: off,
    has_more: (off + keys.length) < total,
  });
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

    // FIX-WORKER-17 pass 269 (atomicity provision seller paridade pass 261):
    //   PRE-FIX: INSERT vault_api_keys + INSERT audit_log em 2 queries separadas
    //   sem tx(). Se key commit mas audit_log falha (DB transient, lock, deadlock):
    //   - vault_api_keys tem row (key ativa)
    //   - audit_log SEM trail forense (LGPD/SOC2 compliance gap)
    //   - Pos-incident: "quem provisionou key X?" -> sem resposta no audit
    //   POST-FIX: tx() wrap all-or-nothing
    //   Pattern paridade pass 261 W17 (/usage endpoint).
    /* FIX-WORKER-17 pass 507 (withRetry deadlock defense - completa cadeia):
       PRE-FIX: tx() sem withRetry. Cenarios deadlock 40P01:
       - Seller burst provision (ansiosamente repete provision em ratelimit window)
       - Race com /rotate cross-seller (audit_log lock ordering)
       - Race com cron rotationAlertCron (SELECT audit_log mass-insert)
       Pass 506 completou rotate + admin provision + revoke. Pass 507 (este)
       fecha cadeia W17: TODOS endpoints write vault agora com withRetry.
       POST-FIX: withRetry wrap (3 attempts backoff).
       Pattern V8 W17 atomicity: rotate + admin_provision + admin_revoke +
       seller_provision + seller_revoke + use - 6/6 com withRetry consolidado. */
    let r;
    await withRetry('vault.seller_provision.tx', async () => await tx(async (c) => {
      r = await c.query(
        `INSERT INTO vault_api_keys
           (seller_id, provider, key_alias, encrypted_key, iv, auth_tag, key_fingerprint,
            monthly_quota_usd_cents, is_platform_pool, expires_at, rotation_due_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW() + ($11 || ' days')::INTERVAL)
         RETURNING id, provider, key_alias, key_fingerprint, is_platform_pool,
                   monthly_quota_usd_cents, created_at, rotation_due_at`,
        [sellerId, provider, key_alias, encrypted, iv, tag, fp,
         monthly_quota_usd_cents || null, isPlatformPool, expires_at || null, String(rotDays)]
      );
      // Audit log seller-led action - dentro tx() atomic
      await c.query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES ($1, $2, 'vault.seller_provision', 'vault_api_key', $3, 'info', $4::JSONB)`,
        [req.user.sub, req.user.role, r.rows[0].id,
         JSON.stringify({
           provider, key_alias, fingerprint: fp, seller_id: sellerId, ip: req.ip,
           // FIX-WORKER-17 pass 438 (ua_prefix forensic - paridade admin provision)
           ua_prefix: mask.text((req.headers['user-agent'] || '').slice(0, 60)),
         })]
      );
    })); // close withRetry pass 507

    /* FIX-WORKER-17 pass 574 (cache invalidation pos-mutation - consume TODO pass 542):
       PRE-FIX (pass 542 TODO): GET /keys/me cached 60s MAS POST nao invalidava.
       - Seller provisiona key -> dashboard reload mostra lista STALE ate 60s
       - User experience 'criei mas nao aparece - bug?'
       - Pass 542 deferiu via TODO comment 'cache.del em POST/revoke se UI ficar slow'
       - Mesmo pattern admin /keys mas pass 489 tambem nao invalida
       POST-FIX: cache.del wildcard 'vault:keys_me:u=USER:*' pos-tx commit.
       - Fire-and-forget catch (Redis down nao bloquear response 201)
       - Admin path 'vault:keys_me:u=admin_user_id:s=seller_filter:*' tambem invalida
         (if admin provisionou para outro seller, mas o seller path mais critico)
       Pattern V8 W13 invariante: TODA mutation que afeta cached read = invalidate.
       Paridade pass 569 notif-svc /prefs cache.del cross-mutation. */
    cache.del(`vault:keys_me:u=${req.user.sub}:*`).catch(() => {});
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

    // FIX-WORKER-17 pass 433 (DLP gap em revoked_reason DB column - completa pass 295):
    //   PRE-FIX (pass 295 partial): audit_log payload_after recebia mask.text(reason)
    //   MAS a coluna DB vault_api_keys.revoked_reason continuava recebendo RAW.
    //   /admin/vault listing (linha 495) ja aplicava mask na LEITURA mas:
    //   - Leitura via psql direto: secret visivel
    //   - Backup pg_dump: secret persiste em backup files (LGPD violation)
    //   - Forensic query SELECT raw: secret bypass mask layer
    //   POST-FIX: mask.text() ANTES UPDATE - DLP em write path (DB-at-rest).
    //   Paridade /keys/:id/rotate pass 433 (mask antes revoked_reason concatenado).
    //   Pattern V8 W17: DLP DEVE ocorrer em WRITE, nao apenas READ.
    const reasonMasked = mask.text(String(req.body.reason || '').slice(0, 500));
    /* FIX-WORKER-17 pass 493 (atomic UPDATE + audit_log paridade pass 269 provision):
       PRE-FIX: UPDATE + INSERT audit_log em 2 queries separadas sem tx().
       Pass 269 corrigiu PROVISION seller (atomicity). REVOKE seller endpoint
       (este) ficou LAGGED:
       - UPDATE commit (key revoked em DB)
       - INSERT audit_log falha (DB transient/lock/deadlock)
       - .catch(() => {}) SWALLOWS error -> audit gap silente
       Compliance impact:
       - LGPD Art 37: registro de tratamento dados (revoke = critical event)
       - SOC2 CC7.3: monitoring deletes/changes em PII assets
       - vault_api_keys.revoked_reason armazena reason mas SEM trail forense
         de QUEM revogou (actor_user_id no audit_log apenas)
       Admin endpoint /keys/:id/revoke (linha 825-) ja tem tx() atomic
       (pass 25 BUG 4 fix). Seller endpoint (este) ficou divergente.
       POST-FIX:
       - tx() wrapping UPDATE + INSERT audit_log atomico
       - withRetry para deadlock 40P01 defesa (paridade pass 310 /use pool)
       - .catch swallow removido (rollback se audit falhar e correcao real)
       - Compliance LGPD/SOC2 garantido: revoke + trail forensic atomic. */
    let revoked = null;
    await withRetry('vault.seller_revoke', async () => {
      await tx(async (c) => {
        const r = await c.query(
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
          isAdmin ? [reasonMasked, req.params.id]
                  : [reasonMasked, req.params.id, req.user.sub]
        );
        if (!r.rows.length) {
          // throw para rollback + handler 404 fora do tx
          const err = new Error('key_not_found_or_already_revoked');
          err.code = 'NOT_FOUND';
          throw err;
        }
        revoked = r.rows[0].id;
        /* FIX-WORKER-17 pass 295 (DLP mask em reason audit):
           Reason eh user-input livre (z.string().min(3).max(500)) - pode conter:
           - Acidental: copia/pasta de API key, JWT token, Bearer header
           - PII: numero CPF mencionado em justificativa
           - Outros secrets: PG_PASS em error message colado
           POST-FIX: mask.text() em reason antes do JSONB store. */
        await c.query(
          `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
           VALUES ($1, $2, 'vault.seller_revoke', 'vault_api_key', $3, 'warn', $4::JSONB)`,
          [req.user.sub, req.user.role, req.params.id,
           JSON.stringify({
             reason: mask.text(req.body.reason.slice(0, 200)),
             ip: req.ip,
             // FIX-WORKER-17 pass 438 (ua_prefix forensic - paridade cross-endpoints vault)
             ua_prefix: mask.text((req.headers['user-agent'] || '').slice(0, 60)),
           })]
        );
      });
    }).catch((e) => {
      if (e?.code === 'NOT_FOUND') return next(errorHandler.notFound('key_not_found_or_already_revoked'));
      throw e; // bubble up para errorHandler middleware (500 generico mascarado)
    });
    if (!revoked) return; // already responded via next() above

    /* FIX-WORKER-17 pass 574 (cache invalidation pos-revoke - paridade POST /keys/me):
       Seller revoga key -> dashboard reload mostra key como 'active' por ate 60s
       (cache miss flag). UX gap user clicked Revoke + reload + ve active = confusion.
       POST-FIX: cache.del wildcard 'vault:keys_me:u=USER:*' pos-tx commit.
       Fire-and-forget catch (Redis down nao bloquear response). */
    cache.del(`vault:keys_me:u=${req.user.sub}:*`).catch(() => {});
    res.json({ ok: true, revoked });
  })
);

app.use((req, res) => res.status(404).json({ error: 'route_not_found' }));
app.use(errorHandler.errorMiddleware);

const server = app.listen(PORT, () => log.info({ port: PORT }, '[vault-svc] listening'));
['SIGINT','SIGTERM'].forEach((s) => process.on(s, () => server.close(() => process.exit(0))));
