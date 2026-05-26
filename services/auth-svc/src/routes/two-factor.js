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

// POST /auth/2fa/setup -> retorna QR + secret temporario
router.post('/setup', asyncHandler(async (req, res) => {
  const secret = authenticator.generateSecret();
  const { encrypted, iv } = cryp.encrypt(secret);
  await query(
    `INSERT INTO user_two_factor (user_id, secret_encrypted, secret_iv, is_enabled)
     VALUES ($1, $2, $3, FALSE)
     ON CONFLICT (user_id) DO UPDATE SET
       secret_encrypted = EXCLUDED.secret_encrypted,
       secret_iv = EXCLUDED.secret_iv,
       is_enabled = FALSE,
       updated_at = NOW()`,
    [req.user.sub, encrypted, iv]
  );
  const otpauth = authenticator.keyuri(req.user.email, process.env.TOTP_ISSUER || 'CodeAgentShop', secret);
  const qr = await QRCode.toDataURL(otpauth);
  res.json({ qr_data_url: qr, otpauth, manual_code: secret });
}));

// POST /auth/2fa/activate -> ativa apos primeiro token correto
router.post('/activate',
  validate({ body: z.object({ token: z.string().length(6) }) }),
  asyncHandler(async (req, res, next) => {
    const r = await query('SELECT secret_encrypted, secret_iv FROM user_two_factor WHERE user_id = $1', [req.user.sub]);
    if (!r.rows.length) return next(errorHandler.notFound('not_set_up'));
    const secret = cryp.decrypt({ encrypted: r.rows[0].secret_encrypted, iv: r.rows[0].secret_iv, tag: Buffer.alloc(0) });
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
    const r = await query('SELECT secret_encrypted, secret_iv FROM user_two_factor WHERE user_id = $1 AND is_enabled', [req.user.sub]);
    if (!r.rows.length) return next(errorHandler.notFound('2fa_not_enabled'));
    const secret = cryp.decrypt({ encrypted: r.rows[0].secret_encrypted, iv: r.rows[0].secret_iv, tag: Buffer.alloc(0) });
    if (!authenticator.check(req.body.token, secret)) return next(errorHandler.unauthorized('invalid_token'));

    await query('UPDATE user_two_factor SET is_enabled = FALSE, disabled_at = NOW() WHERE user_id = $1', [req.user.sub]);
    res.json({ enabled: false });
  })
);

module.exports = router;
