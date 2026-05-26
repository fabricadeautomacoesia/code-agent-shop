'use strict';

const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('node:crypto');
const { z } = require('zod');
const { query, tx } = require('@cas/db-client');
const { jwt, validate, asyncHandler, fail2ban, errorHandler, logger } = require('@cas/shared');

const router = express.Router();
const log = logger.child({ svc: 'auth-svc', mod: 'auth' });

const registerSchema = z.object({
  email: z.string().email().max(180),
  password: z.string().min(8).max(128)
    .refine((s) => /[A-Z]/.test(s) && /[0-9]/.test(s), 'Senha precisa de maiuscula e numero'),
  full_name: z.string().min(2).max(200),
  role: z.enum(['buyer','seller']).default('buyer'),
  cpf_cnpj: z.string().min(11).max(20).optional(),
  phone_e164: z.string().regex(/^\+[1-9]\d{6,14}$/).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  totp: z.string().length(6).optional(),
});

const REFRESH_COOKIE = 'cas_rt';
const REFRESH_TTL_MS = (parseInt(process.env.JWT_REFRESH_TTL || '604800', 10)) * 1000;

function setRefreshCookie(res, refreshToken) {
  res.cookie(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: REFRESH_TTL_MS,
    path: '/auth',
  });
}

// POST /auth/register
router.post('/register', validate({ body: registerSchema }), asyncHandler(async (req, res) => {
  const { email, password, full_name, role, cpf_cnpj, phone_e164 } = req.body;
  const hash = await bcrypt.hash(password, 12);
  try {
    const r = await query(
      `INSERT INTO users (email, password_hash, full_name, role, cpf_cnpj, phone_e164)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, email, full_name, role, created_at`,
      [email, hash, full_name, role, cpf_cnpj || null, phone_e164 || null]
    );
    const user = r.rows[0];
    // Se seller, criar perfil de seller_class=class_a
    if (role === 'seller') {
      const slug = (full_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')) + '-' + Math.floor(Math.random()*9000+1000);
      await query(
        `INSERT INTO sellers (user_id, seller_class, status, store_slug, store_name)
         VALUES ($1, 'class_a', 'pending_kyc', $2, $3)`,
        [user.id, slug.slice(0, 60), full_name]
      );
    }
    log.info({ userId: user.id, role }, '[register]');
    res.status(201).json({ ok: true, user });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'email_already_in_use' });
    throw e;
  }
}));

// POST /auth/login
router.post('/login', fail2ban.middleware(), validate({ body: loginSchema }), asyncHandler(async (req, res, next) => {
  const { email, password, totp } = req.body;
  const r = await query(
    `SELECT u.id, u.email, u.password_hash, u.full_name, u.role, u.is_active, u.is_banned,
            u2.is_enabled AS twofa_enabled, u2.secret_encrypted, u2.iv AS twofa_iv
       FROM users u
       LEFT JOIN user_two_factor u2 ON u2.user_id = u.id
       WHERE u.email = $1 AND u.deleted_at IS NULL`, [email]
  );
  if (!r.rows.length) {
    req.fail2ban?.reportFailure();
    return next(errorHandler.unauthorized('invalid_credentials', 'Email ou senha invalidos'));
  }
  const user = r.rows[0];
  if (user.is_banned) return next(errorHandler.forbidden('user_banned', 'Conta banida'));
  if (!user.is_active) return next(errorHandler.forbidden('user_inactive', 'Conta inativa'));

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    req.fail2ban?.reportFailure();
    await query('UPDATE users SET failed_login_count = failed_login_count + 1 WHERE id = $1', [user.id]);
    return next(errorHandler.unauthorized('invalid_credentials', 'Email ou senha invalidos'));
  }

  // 2FA obrigatorio se habilitado
  if (user.twofa_enabled) {
    if (!totp) return res.status(206).json({ requires_2fa: true });
    const { decrypt } = require('@cas/shared').crypto;
    const { authenticator } = require('otplib');
    const secret = decrypt({ encrypted: user.secret_encrypted, iv: user.twofa_iv, tag: Buffer.alloc(0) });
    if (!authenticator.check(totp, secret)) {
      req.fail2ban?.reportFailure();
      return next(errorHandler.unauthorized('invalid_totp', 'Codigo 2FA invalido'));
    }
  }

  req.fail2ban?.reportSuccess();

  const access  = jwt.signAccess({ sub: user.id, role: user.role, email: user.email });
  const refresh = jwt.signRefresh({ sub: user.id });

  await query(
    `INSERT INTO user_sessions (user_id, refresh_token_hash, user_agent, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + INTERVAL '7 days')`,
    [user.id, jwt.hashToken(refresh.token), req.headers['user-agent'] || null, req.ip]
  );

  await query('UPDATE users SET last_login_at = NOW(), last_login_ip = $1, failed_login_count = 0 WHERE id = $2',
    [req.ip, user.id]);

  setRefreshCookie(res, refresh.token);
  res.json({
    access_token: access.token,
    expires_in: access.expiresIn,
    user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role },
  });
}));

// POST /auth/refresh
router.post('/refresh', asyncHandler(async (req, res, next) => {
  const rt = req.cookies?.[REFRESH_COOKIE];
  if (!rt) return next(errorHandler.unauthorized('missing_refresh', 'Cookie refresh ausente'));
  let payload;
  try { payload = jwt.verifyRefresh(rt); }
  catch { return next(errorHandler.unauthorized('invalid_refresh', 'Refresh invalido')); }

  const hash = jwt.hashToken(rt);
  const s = await query(
    `SELECT id, user_id, is_revoked, expires_at FROM user_sessions
      WHERE refresh_token_hash = $1`, [hash]
  );
  if (!s.rows.length || s.rows[0].is_revoked || new Date(s.rows[0].expires_at) < new Date()) {
    return next(errorHandler.unauthorized('refresh_revoked', 'Refresh revogado/expirado'));
  }

  const u = await query('SELECT id, email, role FROM users WHERE id = $1 AND deleted_at IS NULL', [payload.sub]);
  if (!u.rows.length) return next(errorHandler.unauthorized('user_not_found'));
  const user = u.rows[0];

  // Rotacionar refresh
  const newRefresh = jwt.signRefresh({ sub: user.id });
  await tx(async (c) => {
    await c.query('UPDATE user_sessions SET is_revoked = TRUE, revoked_at = NOW(), revoked_reason = $1 WHERE id = $2',
      ['rotated', s.rows[0].id]);
    await c.query(
      `INSERT INTO user_sessions (user_id, refresh_token_hash, user_agent, ip_address, expires_at)
       VALUES ($1,$2,$3,$4, NOW() + INTERVAL '7 days')`,
      [user.id, jwt.hashToken(newRefresh.token), req.headers['user-agent'] || null, req.ip]
    );
  });

  const access = jwt.signAccess({ sub: user.id, role: user.role, email: user.email });
  setRefreshCookie(res, newRefresh.token);
  res.json({ access_token: access.token, expires_in: access.expiresIn });
}));

// POST /auth/logout
router.post('/logout', asyncHandler(async (req, res) => {
  const rt = req.cookies?.[REFRESH_COOKIE];
  if (rt) {
    await query('UPDATE user_sessions SET is_revoked = TRUE, revoked_at = NOW(), revoked_reason = $1 WHERE refresh_token_hash = $2',
      ['logout', jwt.hashToken(rt)]);
  }
  res.clearCookie(REFRESH_COOKIE, { path: '/auth' });
  res.json({ ok: true });
}));

// POST /auth/forgot-password
router.post('/forgot-password',
  validate({ body: z.object({ email: z.string().email() }) }),
  asyncHandler(async (req, res) => {
    const tok = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(tok).digest('hex');
    await query(
      `INSERT INTO password_resets (user_id, token_hash, requested_ip, expires_at)
       SELECT id, $1, $2, NOW() + INTERVAL '15 minutes' FROM users WHERE email = $3`,
      [hash, req.ip, req.body.email]
    );
    // notification-svc enviara email assincrono
    res.json({ ok: true, message: 'Se o email existir, enviaremos instrucoes.' });
  })
);

module.exports = router;
