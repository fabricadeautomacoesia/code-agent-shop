'use strict';

const express = require('express');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const bcrypt = require('bcrypt');
const crypto = require('node:crypto');
const { query } = require('@cas/db-client');
const { jwt, validate, asyncHandler, errorHandler, crypto: cryp } = require('@cas/shared');

const router = express.Router();
router.use(jwt.requireAuth());

// FIX-WORKER-17 pass 11: rate-limit em endpoints 2FA TOTP.
// Antes: TODOS endpoints 2FA sem qualquer rate-limit. Vetores reais:
//
// /activate - token 6 digitos = 1M combinacoes
//   Sem rate-limit + paralelismo permite ~16k tentativas/seg
//   Cracking em minutos (mesmo com janela TOTP 30s, paralelo passa)
//   Possivel ativar 2FA com token forjado se segredo vazou + senha capturada
//
// /disable - mesma vulnerabilidade (token 6 dig + senha)
//   Phishing pega senha + brute-force TOTP = bypass 2FA
//
// /recovery - mesmo vetor (regenerate codes precisa senha+token)
//
// /setup - sem rate-limit permite spam encryption AES-256 + DB UPDATE
//   1000 setups/seg = DoS interno (key rotation thrashing)
//
// /status - read-only mas pode fingerprintar usuarios (enabled vs not)
//
// Limits por user_id (key=req.user.sub) - mais preciso que IP
// (user com 2FA habilitado em multiples devices = IP shared).

const totpKeyByUser = (req) => req.user?.sub || req.ip;

const totpVerifyLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 min
  max: 10, // 10 tentativas de token / 5min / user (cracking impossivel)
  message: { error: 'rate_limit_exceeded', message: 'Muitas tentativas de codigo TOTP. Aguarde 5 minutos.' },
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: totpKeyByUser,
});

const totpSetupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1h
  max: 5, // 5 setups/h/user (user nao re-configura 2FA mais que 1-2x/h)
  message: { error: 'rate_limit_exceeded', message: 'Muitas configuracoes 2FA. Aguarde 1 hora.' },
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: totpKeyByUser,
});

const totpStatusLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 30, // 30 reads/min/user (frontend pode ler em /conta/seguranca polling)
  message: { error: 'rate_limit_exceeded' },
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: totpKeyByUser,
});

// FIX-WORKER-6 pass 1: GET /auth/2fa/status - frontend /conta/seguranca consulta
// estado 2FA do usuario logado. Antes, frontend confiava em me.twofa_enabled,
// mas isso so e setado quando is_enabled=true (apos activate). Apos /setup mas
// antes de /activate, o user ja tem segredo em DB mas nao reflete no /me ->
// UI nao sabia se ja existia setup pendente, levando usuario a regenerar
// segredos infinitamente (cada /setup sobrescreve). Status endpoint mostra
// estado real: has_pending_setup, enabled, recovery_codes_count.
router.get('/status', totpStatusLimiter, asyncHandler(async (req, res) => {
  const r = await query(
    `SELECT is_enabled, enabled_at, disabled_at, secret_tag IS NOT NULL AS has_secret,
            COALESCE(jsonb_array_length(recovery_codes_hash), 0) AS recovery_count
       FROM user_two_factor WHERE user_id = $1`,
    [req.user.sub]
  );
  if (!r.rows.length) {
    return res.json({ enabled: false, has_pending_setup: false, recovery_count: 0 });
  }
  const row = r.rows[0];
  res.json({
    enabled: !!row.is_enabled,
    has_pending_setup: !!row.has_secret && !row.is_enabled,
    enabled_at: row.enabled_at,
    disabled_at: row.disabled_at,
    recovery_count: Number(row.recovery_count) || 0,
  });
}));

// POST /auth/2fa/setup -> retorna QR + secret temporario
router.post('/setup', totpSetupLimiter, asyncHandler(async (req, res) => {
  const secret = authenticator.generateSecret();
  const { encrypted, iv, tag } = cryp.encrypt(secret);
  // FIX SEG-2FA: tag GCM (16 bytes) eh obrigatorio para validar integridade do segredo TOTP
  await query(
    `INSERT INTO user_two_factor (user_id, secret_encrypted, secret_iv, secret_tag, is_enabled)
     VALUES ($1, $2, $3, $4, FALSE)
     ON CONFLICT (user_id) DO UPDATE SET
       secret_encrypted = EXCLUDED.secret_encrypted,
       secret_iv = EXCLUDED.secret_iv,
       secret_tag = EXCLUDED.secret_tag,
       is_enabled = FALSE,
       updated_at = NOW()`,
    [req.user.sub, encrypted, iv, tag]
  );
  const otpauth = authenticator.keyuri(req.user.email, process.env.TOTP_ISSUER || 'CodeAgentShop', secret);
  const qr = await QRCode.toDataURL(otpauth);
  res.json({ qr_data_url: qr, otpauth, manual_code: secret });
}));

// POST /auth/2fa/activate -> ativa apos primeiro token correto
router.post('/activate',
  totpVerifyLimiter,
  validate({ body: z.object({ token: z.string().length(6) }) }),
  asyncHandler(async (req, res, next) => {
    const r = await query('SELECT secret_encrypted, secret_iv, secret_tag FROM user_two_factor WHERE user_id = $1', [req.user.sub]);
    if (!r.rows.length || !r.rows[0].secret_tag) return next(errorHandler.notFound('not_set_up'));
    // FIX SEG-2FA: passa tag real (BYTEA 16 bytes) para setAuthTag validar GCM
    const secret = cryp.decrypt({ encrypted: r.rows[0].secret_encrypted, iv: r.rows[0].secret_iv, tag: r.rows[0].secret_tag });
    if (!authenticator.check(req.body.token, secret)) return next(errorHandler.badRequest('invalid_token'));

    const recovery = Array.from({ length: 10 }, () => crypto.randomBytes(5).toString('hex'));
    const hashed = await Promise.all(recovery.map((r) => bcrypt.hash(r, 10)));
    await query(
      `UPDATE user_two_factor SET is_enabled = TRUE, enabled_at = NOW(), recovery_codes_hash = $1::JSONB WHERE user_id = $2`,
      [JSON.stringify(hashed), req.user.sub]
    );
    res.json({ enabled: true, recovery_codes: recovery, warn: 'Guarde estes codigos. Nao serao mostrados novamente.' });
  })
);

// FIX-WORKER-6 pass 2: POST /auth/2fa/recovery - regenera codigos de recuperacao
// Exige senha + token TOTP atual (mesmo nivel de seguranca de /disable).
// Substitui os 10 codigos antigos (que podem ter sido perdidos/usados).
// V8 4.2: alto risco -> mesmo gate de seguranca que disable.
router.post('/recovery',
  totpVerifyLimiter,
  validate({ body: z.object({ password: z.string(), token: z.string().length(6) }) }),
  asyncHandler(async (req, res, next) => {
    const u = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.sub]);
    if (!u.rows.length || !(await bcrypt.compare(req.body.password, u.rows[0].password_hash))) {
      return next(errorHandler.unauthorized('invalid_password'));
    }
    const r = await query(
      'SELECT secret_encrypted, secret_iv, secret_tag FROM user_two_factor WHERE user_id = $1 AND is_enabled',
      [req.user.sub]
    );
    if (!r.rows.length || !r.rows[0].secret_tag) return next(errorHandler.notFound('2fa_not_enabled'));
    const secret = cryp.decrypt({ encrypted: r.rows[0].secret_encrypted, iv: r.rows[0].secret_iv, tag: r.rows[0].secret_tag });
    if (!authenticator.check(req.body.token, secret)) return next(errorHandler.unauthorized('invalid_token'));

    const recovery = Array.from({ length: 10 }, () => crypto.randomBytes(5).toString('hex'));
    const hashed = await Promise.all(recovery.map((c) => bcrypt.hash(c, 10)));
    await query(
      `UPDATE user_two_factor SET recovery_codes_hash = $1::JSONB, updated_at = NOW() WHERE user_id = $2`,
      [JSON.stringify(hashed), req.user.sub]
    );
    res.json({ recovery_codes: recovery, warn: 'Codigos antigos invalidados. Guarde os novos com seguranca.' });
  })
);

// POST /auth/2fa/disable -> exige senha + token (V8 4.2)
// FIX-WORKER-6 pass 3: idempotente. Se ja desabilitado, valida senha (gate de
// auth pra nao vazar estado) e retorna 200 enabled:false. Antes retornava 404
// "2fa_not_enabled" que confundia o frontend (UI mostrava erro generico).
// Token TOTP nao e exigido nesse caso porque nao ha secret valido.
router.post('/disable',
  totpVerifyLimiter,
  validate({ body: z.object({ password: z.string(), token: z.string().length(6).optional() }) }),
  asyncHandler(async (req, res, next) => {
    const u = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.sub]);
    if (!u.rows.length || !(await bcrypt.compare(req.body.password, u.rows[0].password_hash))) {
      return next(errorHandler.unauthorized('invalid_password'));
    }
    const r = await query('SELECT secret_encrypted, secret_iv, secret_tag, is_enabled FROM user_two_factor WHERE user_id = $1', [req.user.sub]);
    // Idempotencia: ja desabilitado (ou nunca configurado) -> 200 sem-op
    if (!r.rows.length || !r.rows[0].secret_tag || !r.rows[0].is_enabled) {
      return res.json({ enabled: false, idempotent: true });
    }
    // Path normal: 2FA ativo -> exige token TOTP valido
    if (!req.body.token) return next(errorHandler.badRequest('token_required'));
    // FIX SEG-2FA: tag real do GCM
    const secret = cryp.decrypt({ encrypted: r.rows[0].secret_encrypted, iv: r.rows[0].secret_iv, tag: r.rows[0].secret_tag });
    if (!authenticator.check(req.body.token, secret)) return next(errorHandler.unauthorized('invalid_token'));

    await query('UPDATE user_two_factor SET is_enabled = FALSE, disabled_at = NOW() WHERE user_id = $1', [req.user.sub]);
    res.json({ enabled: false });
  })
);

module.exports = router;
