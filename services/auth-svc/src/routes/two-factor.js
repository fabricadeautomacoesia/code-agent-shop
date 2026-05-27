'use strict';

const express = require('express');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const { z } = require('zod');
const bcrypt = require('bcrypt');
const crypto = require('node:crypto');
const { query } = require('@cas/db-client');
const { jwt, validate, asyncHandler, errorHandler, crypto: cryp } = require('@cas/shared');

const router = express.Router();
router.use(jwt.requireAuth());

// FIX-WORKER-6 pass 1: GET /auth/2fa/status - frontend /conta/seguranca consulta
// estado 2FA do usuario logado. Antes, frontend confiava em me.twofa_enabled,
// mas isso so e setado quando is_enabled=true (apos activate). Apos /setup mas
// antes de /activate, o user ja tem segredo em DB mas nao reflete no /me ->
// UI nao sabia se ja existia setup pendente, levando usuario a regenerar
// segredos infinitamente (cada /setup sobrescreve). Status endpoint mostra
// estado real: has_pending_setup, enabled, recovery_codes_count.
router.get('/status', asyncHandler(async (req, res) => {
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
router.post('/setup', asyncHandler(async (req, res) => {
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

// POST /auth/2fa/disable -> exige senha + token (V8 4.2)
router.post('/disable',
  validate({ body: z.object({ password: z.string(), token: z.string().length(6) }) }),
  asyncHandler(async (req, res, next) => {
    const u = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.sub]);
    if (!u.rows.length || !(await bcrypt.compare(req.body.password, u.rows[0].password_hash))) {
      return next(errorHandler.unauthorized('invalid_password'));
    }
    const r = await query('SELECT secret_encrypted, secret_iv, secret_tag FROM user_two_factor WHERE user_id = $1 AND is_enabled', [req.user.sub]);
    if (!r.rows.length || !r.rows[0].secret_tag) return next(errorHandler.notFound('2fa_not_enabled'));
    // FIX SEG-2FA: tag real do GCM
    const secret = cryp.decrypt({ encrypted: r.rows[0].secret_encrypted, iv: r.rows[0].secret_iv, tag: r.rows[0].secret_tag });
    if (!authenticator.check(req.body.token, secret)) return next(errorHandler.unauthorized('invalid_token'));

    await query('UPDATE user_two_factor SET is_enabled = FALSE, disabled_at = NOW() WHERE user_id = $1', [req.user.sub]);
    res.json({ enabled: false });
  })
);

module.exports = router;
