'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const express = require('express');
const nodeCrypto = require('node:crypto');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { query } = require('@cas/db-client');
const { logger, sanitize, errorHandler, asyncHandler, jwt, validate, crypto: cryp } = require('@cas/shared');

const log = logger.child({ svc: 'vault-svc' });
const app = express();
const PORT = parseInt(process.env.PORT_VAULT || '3020', 10);

app.disable('x-powered-by');
// FIX-WORKER-17: trust proxy para rate-limit usar IP real (x-forwarded-for do gateway)
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));
app.use(sanitize.middleware());

app.get('/health', (_req, res) => res.json({ ok: true, svc: 'vault-svc' }));

const adminOnly = jwt.requireAuth({ roles: ['admin', 'staff'] });
const sellerOrAdmin = jwt.requireAuth({ roles: ['seller', 'admin', 'staff'] });

const provisionSchema = z.object({
  seller_id: z.string().uuid().nullable().optional(),
  provider: z.enum(['openai','anthropic','gemini','groq','cohere','mistral','azure-openai','custom']),
  key_alias: z.string().min(3).max(100),
  plain_key: z.string().min(10),
  monthly_quota_usd_cents: z.number().int().positive().nullable().optional(),
  is_platform_pool: z.boolean().default(true),
  expires_at: z.string().datetime().optional(),
});

// POST /api/vault/keys -> admin provisiona chave para pool ou seller especifico
app.post('/keys', provisionRateLimit, adminOnly, validate({ body: provisionSchema }), asyncHandler(async (req, res) => {
  const { seller_id, provider, key_alias, plain_key, monthly_quota_usd_cents, is_platform_pool, expires_at } = req.body;
  const { encrypted, iv, tag } = cryp.encrypt(plain_key);
  const fp = cryp.sha256(plain_key).slice(0, 16);
  const r = await query(
    `INSERT INTO vault_api_keys
       (seller_id, provider, key_alias, encrypted_key, iv, auth_tag, key_fingerprint,
        monthly_quota_usd_cents, is_platform_pool, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id, provider, key_alias, key_fingerprint, is_platform_pool, monthly_quota_usd_cents, created_at`,
    [seller_id || null, provider, key_alias, encrypted, iv, tag, fp, monthly_quota_usd_cents || null, is_platform_pool, expires_at || null]
  );
  log.info({ provisioned: r.rows[0].id, provider, fp }, '[vault.provision]');
  res.status(201).json(r.rows[0]);
}));

// GET /api/vault/keys -> lista (mascarado, sem expor plain)
app.get('/keys', adminOnly, asyncHandler(async (req, res) => {
  const r = await query(
    `SELECT id, seller_id, provider, key_alias, key_fingerprint, is_active, is_platform_pool,
            monthly_quota_usd_cents, usage_this_month_cents, expires_at, rotation_due_at,
            last_used_at, created_at, revoked_at, revoked_reason
       FROM vault_api_keys
       ORDER BY created_at DESC LIMIT 200`
  );
  res.json({ keys: r.rows });
}));

// POST /api/vault/use -> internal: outro svc pede chave para usar
// FIX SEG-VAULT-1: APENAS admin/staff OU header interno x-internal-token compativel com VAULT_INTERNAL_TOKEN
// Antes, qualquer JWT valido (incluindo buyer comum) podia chamar este endpoint e
// receber plain_key da pool da plataforma - vazamento critico.
// FIX-WORKER-17 (timing-safe): comparacao '===' do token interno era vulneravel
// a timing attack. Atacante pode descobrir o token caractere por caractere medindo
// tempo de resposta. crypto.timingSafeEqual com Buffer de mesmo length resolve.
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
    if (valid) return next();
    // Token enviado mas invalido -> log para forensics (possivel brute-force)
    log.warn({
      ip: req.ip,
      ua: req.headers['user-agent'],
      tok_len: String(internalTok).length,
      expected_len: expected.length,
    }, '[vault.invalid_internal_token]');
  }
  // senao (sem header ou invalido), exige JWT com role privilegiado
  return jwt.requireAuth({ roles: ['admin', 'staff', 'service'] })(req, res, next);
}

// FIX-WORKER-17 (rate-limit): /use eh o endpoint que retorna plain_key.
// 30 reqs/min por IP eh generoso para uso legitimo (LLM calls) mas barra
// brute-force de VAULT_INTERNAL_TOKEN.
const useRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.VAULT_USE_RATE_LIMIT || '30', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limit_exceeded' },
  // Considera IP do x-forwarded-for (gateway propaga)
  keyGenerator: (req) => req.headers['x-real-ip'] || req.ip,
});

// Provisionamento de chaves: 5/min eh suficiente (admin operacao manual)
const provisionRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limit_exceeded' },
});

app.post('/use',
  useRateLimit,
  vaultUseGuard,
  validate({ body: z.object({ provider: z.string(), seller_id: z.string().uuid().optional(), operation: z.string().optional() }) }),
  asyncHandler(async (req, res, next) => {
    const { provider, seller_id, operation } = req.body;
    // 1. tenta seller-specific
    let r = seller_id ? await query(
      `SELECT * FROM vault_api_keys
        WHERE provider = $1 AND seller_id = $2 AND is_active AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY created_at DESC LIMIT 1`,
      [provider, seller_id]
    ) : { rows: [] };
    // 2. fallback platform pool
    if (!r.rows.length) {
      r = await query(
        `SELECT * FROM vault_api_keys
          WHERE provider = $1 AND is_platform_pool AND is_active AND (expires_at IS NULL OR expires_at > NOW())
          ORDER BY last_used_at NULLS FIRST, created_at ASC LIMIT 1`,
        [provider]
      );
    }
    if (!r.rows.length) return next(errorHandler.notFound('no_key_available'));
    const k = r.rows[0];
    let plain;
    try {
      plain = cryp.decrypt({ encrypted: k.encrypted_key, iv: k.iv, tag: k.auth_tag });
    } catch (e) {
      // FIX SEG-VAULT-2: nao vaza exception message ao cliente (DLP). Loga estruturado server-side.
      log.error({ err: e.message, key_id: k.id, fp: k.key_fingerprint }, '[vault.decrypt_fail]');
      return next(errorHandler.serverError('decrypt_failed'));
    }
    await query('UPDATE vault_api_keys SET last_used_at = NOW(), last_used_ip = $1 WHERE id = $2', [req.ip, k.id]);
    res.json({
      key_id: k.id, provider: k.provider, fingerprint: k.key_fingerprint, plain_key: plain,
      is_platform_pool: k.is_platform_pool, alias: k.key_alias,
    });
    // log granular assincrono
    query(
      `INSERT INTO vault_key_usage (vault_key_id, seller_id, operation, ip_address)
       VALUES ($1,$2,$3,$4)`,
      [k.id, seller_id || null, operation || null, req.ip]
    ).catch((e) => log.warn({ err: e.message }, '[vault.usage_log_failed]'));
  })
);

// POST /api/vault/keys/:id/revoke
app.post('/keys/:id/revoke', adminOnly,
  validate({ body: z.object({ reason: z.string().max(200) }) }),
  asyncHandler(async (req, res) => {
    await query(
      `UPDATE vault_api_keys SET is_active = FALSE, revoked_at = NOW(), revoked_reason = $1 WHERE id = $2`,
      [req.body.reason, req.params.id]
    );
    res.json({ ok: true });
  })
);

// POST /api/vault/usage -> registra custo de uma chamada (faturar Classe B)
app.post('/usage', jwt.requireAuth(),
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

app.use((req, res) => res.status(404).json({ error: 'route_not_found' }));
app.use(errorHandler.errorMiddleware);

const server = app.listen(PORT, () => log.info({ port: PORT }, '[vault-svc] listening'));
['SIGINT','SIGTERM'].forEach((s) => process.on(s, () => server.close(() => process.exit(0))));
