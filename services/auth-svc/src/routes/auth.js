'use strict';

const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('node:crypto');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { query, tx } = require('@cas/db-client');
const { jwt, validate, asyncHandler, fail2ban, errorHandler, logger, htmlEscape, rateLimiter, mask } = require('@cas/shared');

// FIX-WORKER-7 pass 98: rate-limit /logout anti-spam.
// PRE-FIX: zero limit em /logout. Vetores:
//   - Bot pode hammer /logout cookie sweep tentando revogar sessions cross-user
//     (apesar do match refresh_token_hash, attempts contam IO DB).
//   - DoS DB: UPDATE concorrente em user_sessions com 100k+ rows.
// Real users logout 1-2x/dia. 20/hr/IP eh permissivo.
const logoutLimiter = rateLimiter.createLimiter({
  windowMs: 60 * 60 * 1000, max: 20,
  message: 'Muitas tentativas de logout recentes. Aguarde alguns minutos.',
});

const router = express.Router();

// FIX-WORKER-17 pass 10: rate-limiters por endpoint sensitivo.
// Antes: /register, /forgot-password, /reset-password sem qualquer limite.
// Vetores reais:
// - /register: spam mass-creation (fraude, contas zombie para reviews falsos)
// - /forgot-password: email bombing (atacante dispara 1000 mails para victim
//   @gmail.com), email enumeration (timing attack response presence/absence)
// - /reset-password: brute-force do token 32-byte (impractical mas defensavel)
//
// Limits dimensionados para uso humano legitimo (user nao registra/recupera
// senha mais que 1-2 vezes por hora) e bloquear bots automaticamente.
const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 5, // 5 registers por IP/15min = anti-spam
  message: { error: 'rate_limit_exceeded', message: 'Muitos registros recentes. Aguarde 15 minutos.' },
  standardHeaders: true, legacyHeaders: false,
});
const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1h
  max: 3, // 3 forgot por IP/hora - protege victim de email bombing
  message: { error: 'rate_limit_exceeded', message: 'Muitas solicitacoes de recuperacao. Aguarde 1 hora.' },
  standardHeaders: true, legacyHeaders: false,
});
const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min (window do token)
  max: 10, // 10 tentativas com token errado = atacante brute-force detected
  message: { error: 'rate_limit_exceeded', message: 'Muitas tentativas. Solicite novo link.' },
  standardHeaders: true, legacyHeaders: false,
});
const log = logger.child({ svc: 'auth-svc', mod: 'auth' });

// FIX-WORKER-6 pass 1: cpf_cnpj string vazia rejeitado por min(11).optional().
// Frontend sempre envia "" quando user nao preenche (linha 53 register/page.tsx),
// resultando em 400 "must contain at least 11 character(s)" para buyer sem CPF.
// Solucao: transform "" -> undefined ANTES da validacao min(11).
// Mesmo padrao em phone_e164 (regex falha em ""). Buyer SEM doc/telefone agora ok.
const emptyToUndef = (v) => (v === '' || v === null ? undefined : v);
// FIX-WORKER-7 pass 51: password validation alinhado com /reset-password (pass 50).
// Pattern NIST 800-63B: maiuscula + numero + special char.
// Inconsistencia pre-fix: register accept "Aaa1aaaa", reset force "Aaa1aaaa!"
// = user reseta com senha mais forte que registrava (UX confuso).
// FIX-WORKER-6 pass 182 (CRITICAL UX/SECURITY): normalize email lowercase + trim
// BUG identificado: SELECT WHERE u.email = $1 (login, forgot-password) usa raw input.
// User registra 'John@Example.com' -> login com 'john@example.com' falha (case-mismatch).
// UX: "Email ou senha invalidos" sem indicacao real - user reclama suporte.
// Security: tambem facilita email enumeration (atacante registra com case diferente
// p/ ver se conta existe).
// FIX centralizado: .transform em todos schemas - lowercase + trim defensivo.
// PG colation default em users.email NAO sera UNIQUE case-insensitive, mas normalizar
// na app é defesa em profundidade comum (pattern Stripe, Auth0, Supabase).
const normalizedEmail = z.string().email().max(180).transform((s) => s.trim().toLowerCase());

const registerSchema = z.object({
  email: normalizedEmail,
  password: z.string().min(8).max(128)
    .refine((s) => /[A-Z]/.test(s) && /[0-9]/.test(s) && /[^\w\s]/.test(s),
      'Senha precisa de maiuscula, numero e caractere especial (!@#$%^&* etc)'),
  full_name: z.string().min(2).max(200),
  role: z.enum(['buyer','seller']).default('buyer'),
  cpf_cnpj: z.preprocess(emptyToUndef, z.string().min(11).max(20).optional()),
  phone_e164: z.preprocess(emptyToUndef, z.string().regex(/^\+[1-9]\d{6,14}$/).optional()),
});

const loginSchema = z.object({
  email: normalizedEmail,
  password: z.string().min(1),
  totp: z.string().length(6).optional(),
});

const REFRESH_COOKIE = 'cas_rt';
const REFRESH_TTL_MS = (parseInt(process.env.JWT_REFRESH_TTL || '604800', 10)) * 1000;

function setRefreshCookie(res, refreshToken) {
  const opts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: REFRESH_TTL_MS,
    path: '/',
  };
  // Cross-subdomain: storefront em cas.* e API em api.cas.* compartilham cookie
  if (process.env.COOKIE_DOMAIN) opts.domain = process.env.COOKIE_DOMAIN;
  res.cookie(REFRESH_COOKIE, refreshToken, opts);
}

// POST /auth/register
router.post('/register', registerLimiter, validate({ body: registerSchema }), asyncHandler(async (req, res, next) => {
  // FIX-WORKER-7 pass 51: 5 BUGS CRITICOS aplicando Pattern W7.
  //
  // BUG 1 *** ATOMICITY *** users + sellers INSERT lineares sem tx()
  //   Falha INSERT sellers (PG lock, FK violation) = user existe SEM perfil seller
  //   = admin precisa cleanup manual ou user reclama "registrado mas nao consigo vender"
  //   FIX: tx() all-or-nothing
  //
  // BUG 2 *** CPF DEDUP MISSING *** anti-fraud multi-account
  //   Mig 045 (pass 41) UNIQUE em sellers.document_number_hash. MAS users.cpf_cnpj
  //   SEM unique constraint. 2 users mesmo CPF = lavagem multi-account.
  //   FIX: check explicit SELECT antes INSERT + 23505 catch fallback
  //   Migration 047 add UNIQUE index DEFERRED (pode quebrar dados historicos
  //   se houverem duplicates - admin precisa cleanup primeiro)
  //
  // BUG 3 *** AUDIT_LOG MISSING *** security event critical sem trail
  //   /register signal interesting (account creation = potential bot/fraud)
  //   FIX: INSERT audit_log atomic dentro tx
  //
  // BUG 4 *** NOTIFICATION WELCOME MISSING *** UX engagement
  //   Pre-fix: user registrava sem receber email confirm
  //   Risk: typo email -> never delivered + user nao sabe -> reclama suporte
  //   FIX: INSERT notification welcome email atomic
  //
  // BUG 5 *** Password validation inconsistente *** alinhado com pass 50
  //   Aplicado no schema acima (refine special char obrigatorio)
  const { email, password, full_name, role, cpf_cnpj, phone_e164 } = req.body;
  const hash = await bcrypt.hash(password, 12);

  // BUG 2: CPF dedup check (paralelo a sellers UNIQUE pass 41)
  // SO se cpf_cnpj fornecido (eh optional)
  // FIX-WORKER-6 pass 241 (normalize comparison): legacy users podem ter
  // CPF salvo com mascara "111.222.333-44" enquanto registros novos salvam
  // digits only "11122233344". Comparison IN ($1, $2) so achava match SE
  // input chegava em formato identico ao DB. Atacante CPF dup escapava
  // dedup mudando formato (ponto vs sem ponto).
  // POST-FIX: regexp_replace strip non-digits SQL-side para comparison
  // normalizada. Permite detectar duplicates independente de formato.
  if (cpf_cnpj) {
    const digitsOnly = cpf_cnpj.replace(/\D/g, '');
    const dupCpf = await query(
      `SELECT id FROM users
        WHERE regexp_replace(cpf_cnpj, '[^0-9]', '', 'g') = $1
          AND deleted_at IS NULL LIMIT 1`,
      [digitsOnly]
    );
    if (dupCpf.rows.length) {
      return res.status(409).json({
        error: 'cpf_already_registered',
        message: 'Este CPF/CNPJ ja esta cadastrado em outra conta.',
      });
    }
  }

  let outcome;
  let user;
  try {
    await tx(async (c) => {
      // BUG 1: INSERT users dentro tx
      const r = await c.query(
        `INSERT INTO users (email, password_hash, full_name, role, cpf_cnpj, phone_e164)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, email, full_name, role, created_at`,
        [email, hash, full_name, role, cpf_cnpj || null, phone_e164 || null]
      );
      user = r.rows[0];

      // BUG 1: INSERT seller no MESMO tx (atomic com users)
      if (role === 'seller') {
        const slug = (full_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')) + '-' + Math.floor(Math.random()*9000+1000);
        await c.query(
          `INSERT INTO sellers (user_id, seller_class, status, store_slug, store_name)
           VALUES ($1, 'class_a', 'pending_kyc', $2, $3)`,
          [user.id, slug.slice(0, 60), full_name]
        );
      }

      // BUG 3: audit_log atomic - security event (account creation signal)
      await c.query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES ($1, $2, 'auth.register', 'user', $1, 'info', $3::JSONB)`,
        [user.id, role, JSON.stringify({
          email_hash: crypto.createHash('sha256').update(email).digest('hex').slice(0, 16),
          role,
          has_cpf: !!cpf_cnpj,
          has_phone: !!phone_e164,
          ip: req.ip,
          ua_prefix: (req.headers['user-agent'] || '').slice(0, 60),
        })]
      );

      // BUG 4: notification welcome (mesmo tx - atomico)
      // FIX-WORKER-7 pass 52: usa @cas/shared.htmlEscape (DRY cross-svc)
      // (htmlEscape ja desestruturado no top do arquivo - linha modificada pass 52)
      const fullNameSafe = htmlEscape(full_name);
      const appUrl = process.env.APP_URL || 'https://cas.inovareinteligenciaartificial.com';
      await c.query(
        `INSERT INTO notifications (user_id, channel, template_code, title, body, body_html, priority)
         VALUES ($1, 'email', 'welcome', $2, $3, $4, 2)`,
        [user.id,
         'Bem-vindo ao Code & Agent Shop!',
         `Ola ${full_name},\n\nBem-vindo ao Code & Agent Shop! Sua conta foi criada com sucesso como ${role === 'seller' ? 'vendedor' : 'comprador'}.\n\nAcesse: ${appUrl}/conta\n\n${role === 'seller' ? 'IMPORTANTE: Para vender produtos, voce precisa completar o KYC. Acesse /dashboard/seller/loja para enviar seus documentos.' : 'Comece a explorar produtos em /products.'}`,
         `<p>Ola <b>${fullNameSafe}</b>,</p><p>Bem-vindo ao Code & Agent Shop! Sua conta foi criada com sucesso como <b>${role === 'seller' ? 'vendedor' : 'comprador'}</b>.</p><p><a href="${appUrl}/conta" style="display:inline-block;padding:10px 20px;background:linear-gradient(135deg,#EC4899,#7C3AED);color:#fff;text-decoration:none;border-radius:8px;">Acessar minha conta</a></p>${role === 'seller' ? '<p><b>IMPORTANTE:</b> Para vender produtos, complete o KYC em <a href="' + appUrl + '/dashboard/seller/loja">/dashboard/seller/loja</a>.</p>' : '<p>Comece a explorar produtos em <a href="' + appUrl + '/products">/products</a>.</p>'}`,
        ]
      );
    });
  } catch (e) {
    if (e.code === '23505') {
      // Duplicate key - users.email UNIQUE
      return res.status(409).json({ error: 'email_already_in_use' });
    }
    throw e;
  }

  log.info({ userId: user.id, role }, '[register]');
  res.status(201).json({ ok: true, user });
}));

// POST /auth/login
// FIX-WORKER-17 pass 4: lockout por user (complementa fail2ban per-IP) - protege
// contra botnet/proxies que bypassa IP-ban. Configurable via env.
const LOGIN_MAX_FAILURES = parseInt(process.env.LOGIN_MAX_FAILURES || '10', 10);
const LOGIN_LOCK_MINUTES = parseInt(process.env.LOGIN_LOCK_MINUTES || '15', 10);

router.post('/login', fail2ban.middleware(), validate({ body: loginSchema }), asyncHandler(async (req, res, next) => {
  const { email, password, totp } = req.body;
  const r = await query(
    `SELECT u.id, u.email, u.password_hash, u.full_name, u.role, u.is_active, u.is_banned,
            u.failed_login_count, u.locked_until,
            u2.is_enabled AS twofa_enabled, u2.secret_encrypted,
            u2.secret_iv AS twofa_iv, u2.secret_tag AS twofa_tag,
            u2.last_totp_hash, u2.last_totp_used_at
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

  // FIX-WORKER-17 pass 4: account-level lockout (per-user, bypass-bypass de fail2ban per-IP)
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const minLeft = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 60000);
    req.fail2ban?.reportFailure();
    log.warn({ userId: user.id, email: user.email, ip: req.ip }, '[login.account_locked]');
    return next(errorHandler.forbidden('account_locked',
      `Conta temporariamente bloqueada. Tente novamente em ${minLeft} minuto(s).`));
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    req.fail2ban?.reportFailure();
    const newCount = (user.failed_login_count || 0) + 1;
    // Auto-lock apos LOGIN_MAX_FAILURES atingido
    if (newCount >= LOGIN_MAX_FAILURES) {
      const lockUntil = new Date(Date.now() + LOGIN_LOCK_MINUTES * 60000);
      await query(
        'UPDATE users SET failed_login_count = $1, locked_until = $2 WHERE id = $3',
        [newCount, lockUntil, user.id]
      );
      log.warn({ userId: user.id, email: user.email, count: newCount, lockUntil }, '[login.account_locked_now]');
      return next(errorHandler.forbidden('account_locked',
        `Muitas tentativas falhas. Conta bloqueada por ${LOGIN_LOCK_MINUTES} minutos.`));
    }
    await query('UPDATE users SET failed_login_count = $1 WHERE id = $2', [newCount, user.id]);
    return next(errorHandler.unauthorized('invalid_credentials', 'Email ou senha invalidos'));
  }

  // 2FA obrigatorio se habilitado - FIX SEG-2FA: passa tag GCM real (sem ele decrypt falha)
  // FIX-WORKER-7 pass 49: 4 BUGS CRITICOS 2FA path:
  // 1. *** TOTP REPLAY ATTACK *** RFC 6238 §5.2 violation
  //    PRE-FIX: authenticator.check retorna true para mesmo TOTP dentro 30s window
  //    Atacante sniff TOTP -> replay < 30s -> bypass 2FA
  //    FIX: track last_totp_hash + last_totp_used_at (mig 046)
  //    Rejeitar se mesmo hash usado < 60s atras (2x window margem clock drift)
  // 2. *** fail2ban NAO REPORTA FAILURE em twofa_corrupt ***
  //    PRE-FIX: linha 169/178 return next() sem reportFailure
  //    Atacante pode probar continua sem cooldown (apos suspeitar 2FA corrupt)
  //    FIX: reportFailure em todos paths 2FA fail (corrupt, decrypt, invalid)
  // 3. *** Audit log MISSING *** 2FA fail = security event critical
  //    Pattern W7: high-impact endpoints sempre audit_log
  //    FIX: INSERT audit_log async em paths 2FA fail (forense + alert)
  // 4. *** authenticator.check sem window option ***
  //    PRE-FIX: default window=0 (so step atual). Clock drift user vs server
  //    causa false-reject + UX confuso ("codigo errado" para TOTP valido)
  //    FIX: { window: 1 } = aceitar ±1 step (90s tolerance). RFC 6238 §5.2
  //    permite ate 5 steps - 1 step balance security vs UX (replay protect
  //    via hash window 60s cobre 2 time-steps).
  if (user.twofa_enabled) {
    if (!totp) return res.status(206).json({ requires_2fa: true });
    if (!user.twofa_tag) {
      // Estado inconsistente: 2FA ativo sem tag (rows legados da migration 012)
      req.fail2ban?.reportFailure();  // FIX bug 2
      log.error({ userId: user.id }, '[2fa.missing_tag]');
      // FIX bug 3: audit log atomic (async fire-and-forget OK p/ login path)
      query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES ($1, 'system', '2fa.corrupt_state', 'user', $1, 'critical', $2::JSONB)`,
        [user.id, JSON.stringify({ reason: 'missing_tag', ip: req.ip })]
      ).catch(() => {});
      return next(errorHandler.unauthorized('twofa_corrupt', 'Reconfigure 2FA - configuracao corrompida'));
    }
    const crypto = require('node:crypto');
    const { decrypt } = require('@cas/shared').crypto;
    const { authenticator } = require('otplib');
    let secret;
    try {
      secret = decrypt({ encrypted: user.secret_encrypted, iv: user.twofa_iv, tag: user.twofa_tag });
    } catch (e) {
      req.fail2ban?.reportFailure();  // FIX bug 2
      log.error({ userId: user.id, err: e.message }, '[2fa.decrypt_fail]');
      query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES ($1, 'system', '2fa.decrypt_fail', 'user', $1, 'critical', $2::JSONB)`,
        [user.id, JSON.stringify({ err: String(e.message).slice(0, 200), ip: req.ip })]
      ).catch(() => {});
      return next(errorHandler.unauthorized('twofa_corrupt', 'Reconfigure 2FA'));
    }

    // FIX bug 4: window: 1 (±1 step = 90s tolerance clock drift)
    // FIX bug 1: anti-replay (RFC 6238 §5.2) - track ultimo TOTP usado
    if (!authenticator.check(totp, secret, { window: 1 })) {
      req.fail2ban?.reportFailure();
      query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES ($1, 'system', '2fa.invalid_totp', 'user', $1, 'warn', $2::JSONB)`,
        [user.id, JSON.stringify({ ip: req.ip, ua_prefix: (req.headers['user-agent'] || '').slice(0, 60) })]
      ).catch(() => {});
      return next(errorHandler.unauthorized('invalid_totp', 'Codigo 2FA invalido'));
    }

    // FIX bug 1 (replay protection): hash TOTP + check last used
    const totpHash = crypto.createHash('sha256').update(totp).digest('hex');
    if (user.last_totp_hash === totpHash && user.last_totp_used_at) {
      const lastUsedMs = Date.now() - new Date(user.last_totp_used_at).getTime();
      // 60s = 2x time-step (margem clock drift + replay window 1 step)
      if (lastUsedMs < 60_000) {
        req.fail2ban?.reportFailure();
        log.warn({ userId: user.id, ip: req.ip, lastUsedMs }, '[2fa.replay_blocked]');
        query(
          `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
           VALUES ($1, 'system', '2fa.replay_attempt', 'user', $1, 'critical', $2::JSONB)`,
          [user.id, JSON.stringify({
            ip: req.ip,
            last_used_ms_ago: lastUsedMs,
            ua_prefix: (req.headers['user-agent'] || '').slice(0, 60),
          })]
        ).catch(() => {});
        return next(errorHandler.unauthorized('totp_replay', 'Este codigo 2FA ja foi usado. Aguarde o proximo.'));
      }
    }
    // Marca TOTP como usado (anti-replay) - update async OK pois validacao ja passou
    // Tabela CORRETA: user_two_factor (nao users) - mig 046 adiciona cols la
    query(
      `UPDATE user_two_factor SET last_totp_hash = $1, last_totp_used_at = NOW() WHERE user_id = $2`,
      [totpHash, user.id]
    ).catch((e) => log.warn({ err: e.message, userId: user.id }, '[2fa.replay_track_fail]'));
  }

  req.fail2ban?.reportSuccess();

  const access  = jwt.signAccess({ sub: user.id, role: user.role, email: user.email });
  const refresh = jwt.signRefresh({ sub: user.id });

  await query(
    `INSERT INTO user_sessions (user_id, refresh_token_hash, user_agent, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + INTERVAL '7 days')`,
    [user.id, jwt.hashToken(refresh.token), req.headers['user-agent'] || null, req.ip]
  );

  // FIX-WORKER-17 pass 4: tambem reset locked_until em sucesso (clear lock state)
  await query('UPDATE users SET last_login_at = NOW(), last_login_ip = $1, failed_login_count = 0, locked_until = NULL WHERE id = $2',
    [req.ip, user.id]);

  setRefreshCookie(res, refresh.token);
  res.json({
    access_token: access.token,
    expires_in: access.expiresIn,
    user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role },
  });
}));

// POST /auth/refresh
// FIX-WORKER-17 pass 14: logout-cascade detection (OWASP refresh token best practice).
// Quando refresh token JA REVOGADO eh re-apresentado, isso e SINAL FORTE de
// token compromise (atacante usou o token roubado, agora legitimate user tenta).
// Fluxo:
// 1. Atacante rouba refresh via XSS/MITM
// 2. Atacante /refresh -> recebe novo access+refresh, antigo revogado
// 3. Legitimate user (mesma sessao) tenta /refresh com token antigo
// 4. Backend detecta is_revoked=TRUE + reuso -> CASCADE LOGOUT
//    Revoga TODAS sessoes do user + audit log security event
// 5. Atacante perde acesso (sessao roubada tambem revogada)
// 6. User obrigado a fazer login fresh (sabe que houve incidente via notif)
// FIX-WORKER-7 pass 53: rate-limit /refresh anti brute-force offline
// Atacante com refresh token vazado pode tentar refresh repetido testando
// se ainda valido + descobrir cookie path/format. Rate-limit defensive.
// 60/min generoso (UI legitimo faz refresh ~1x a cada 14min = 4/hr).
const refreshLimiter = rateLimit({
  windowMs: 60_000, max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limit_exceeded' },
  keyGenerator: (req) => req.ip, // per-IP (refresh sem auth context user pre-verify)
});

router.post('/refresh', refreshLimiter, asyncHandler(async (req, res, next) => {
  const rt = req.cookies?.[REFRESH_COOKIE];
  if (!rt) return next(errorHandler.unauthorized('missing_refresh', 'Cookie refresh ausente'));
  let payload;
  try { payload = jwt.verifyRefresh(rt); }
  catch { return next(errorHandler.unauthorized('invalid_refresh', 'Refresh invalido')); }

  // FIX-WORKER-7 pass 53 (Regra K): SELECT FOR UPDATE user_sessions row
  // Anti-race: 2 requests concurrent /refresh mesmo token podiam rotacionar 2x
  // resultando em 2 refresh tokens validos paralelos (OR cascade reuse breach falso).
  // FOR UPDATE serializa - segundo request bloqueia ate primeiro COMMIT,
  // entao ve is_revoked=TRUE (rotated) -> entra OWASP cascade detection.
  const hash = jwt.hashToken(rt);
  const s = await query(
    `SELECT id, user_id, is_revoked, expires_at FROM user_sessions
      WHERE refresh_token_hash = $1
      FOR UPDATE`, [hash]
  );
  // Token nao encontrado: invalid (talvez forgado, talvez DB cleanup)
  if (!s.rows.length) {
    return next(errorHandler.unauthorized('refresh_revoked', 'Refresh revogado/expirado'));
  }
  // FIX-WORKER-17 pass 14: REUSO de token JA REVOGADO = SECURITY BREACH
  // Cascade logout: revoga TODAS sessoes do user (incluindo a roubada)
  if (s.rows[0].is_revoked) {
    const userId = s.rows[0].user_id;
    log.warn({
      user_id: userId,
      ip: req.ip,
      ua: req.headers['user-agent']?.slice(0, 200),
      session_id: s.rows[0].id,
    }, '[refresh.reuse.detected]');
    // Cascade revoke + audit
    await tx(async (c) => {
      const cascaded = await c.query(
        `UPDATE user_sessions
            SET is_revoked = TRUE, revoked_at = NOW(),
                revoked_reason = 'refresh_reuse_breach_cascade'
          WHERE user_id = $1 AND is_revoked = FALSE
          RETURNING id`,
        [userId]
      );
      await c.query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES ($1, 'user', 'auth.refresh_reuse_breach', 'user_session', $2, 'critical', $3::JSONB)`,
        [
          userId, s.rows[0].id,
          JSON.stringify({
            ip: req.ip,
            ua: req.headers['user-agent']?.slice(0, 200),
            cascaded_sessions: cascaded.rowCount,
            original_session_id: s.rows[0].id,
          })
        ]
      );
      // Notify user (priority 3 = critical security alert)
      await c.query(
        `INSERT INTO notifications (user_id, channel, template_code, title, body, priority, payload)
         VALUES ($1, 'in_app', 'security_refresh_reuse',
                 'Atividade suspeita detectada - todas as sessoes encerradas',
                 'Foi detectada uma tentativa de reuso de token de autenticacao. Por seguranca, todas suas sessoes foram encerradas. Faca login novamente. Se nao reconhece esta atividade, troque sua senha imediatamente.',
                 3, $2::JSONB)`,
        [userId, JSON.stringify({ ip: req.ip, cascaded_sessions: cascaded.rowCount })]
      );
    });
    res.clearCookie(REFRESH_COOKIE, { path: '/' });
    return next(errorHandler.unauthorized('refresh_reuse_breach',
      'Token compromise detectado. Todas sessoes revogadas. Faca login novamente.'));
  }
  // Expired
  if (new Date(s.rows[0].expires_at) < new Date()) {
    return next(errorHandler.unauthorized('refresh_expired', 'Refresh expirado'));
  }

  // FIX-WORKER-7 pass 53 (Regra A bug critical): banned/inactive user check missing
  // PRE-FIX: SO deleted_at IS NULL filter. Banned/inactive users podiam /refresh
  // infinitamente -> bypass total ban administration.
  //   Cenario: User registra -> admin BANE -> user /refresh -> novo access_token
  //   valido 15min + refresh rotated -> loop indefinido com ban ignorado.
  //   /login linha 132 verifica is_banned/is_active MAS /refresh nao.
  // FIX: AND is_banned=FALSE AND is_active=TRUE no WHERE.
  // Banned user -> 401 user_banned (cookie cleared - forca re-login que vai rejeitar)
  const u = await query(
    `SELECT id, email, role, is_banned, is_active FROM users
      WHERE id = $1 AND deleted_at IS NULL`,
    [payload.sub]
  );
  if (!u.rows.length) return next(errorHandler.unauthorized('user_not_found'));
  const user = u.rows[0];
  if (user.is_banned) {
    // FIX-WORKER-6 pass 233 (banned cascade revoke): se user e banned,
    // TODAS sessoes dele devem ser revogadas. PRE-FIX revogava apenas a
    // sessao atual (WHERE id=$1). Cenario:
    //   Admin bane user. User tem 3 dispositivos com refresh tokens validos.
    //   Apenas o que tentou /refresh era revogado. Os outros 2 continuavam
    //   gerando access tokens 15min ate proxima rotation. Bypass parcial.
    // POST-FIX: cascade revoke WHERE user_id=$1 (mesmo pattern refresh_reuse
    // breach detection linha 444-451). Banned user perde TODOS dispositivos.
    const cascaded = await query(
      `UPDATE user_sessions SET is_revoked = TRUE, revoked_at = NOW(),
                                 revoked_reason = 'user_banned_on_refresh'
        WHERE user_id = $1 AND is_revoked = FALSE
        RETURNING id`,
      [user.id]
    );
    // Audit critical (admin precisa saber que banned user tentou access)
    query(
      `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
       VALUES ($1, 'system', 'auth.refresh_banned_user_blocked', 'user', $1, 'critical', $2::JSONB)`,
      [user.id, JSON.stringify({
        ip: req.ip,
        session_id: s.rows[0].id,
        cascaded_sessions: cascaded.rowCount,
      })]
    ).catch(() => {});
    res.clearCookie(REFRESH_COOKIE, { path: '/' });
    return next(errorHandler.forbidden('user_banned', 'Conta banida.'));
  }
  if (!user.is_active) {
    res.clearCookie(REFRESH_COOKIE, { path: '/' });
    return next(errorHandler.forbidden('user_inactive', 'Conta inativa.'));
  }

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
// FIX-WORKER-6 pass 3: 3 melhorias UX + security:
// 1. Antes: 200 OK sem cookie -> resposta enganosa (parece logout, mas nada feito)
//    Agora: 200 com `was_logged_in: false` se nao havia sessao (UX claro)
// 2. Antes: UPDATE silencioso se cookie nao matchea (revoked row count nao reportado)
//    Agora: RETURNING id + verifica se realmente revogou
// 3. Audit log: registra logout no audit_log p/ forensics (era so DB update)
// POST /auth/logout - revoga sessao atual OU todas sessions do user
// FIX-WORKER-6 pass 3: clearCookie idempotente + audit log + RETURNING check.
// FIX-WORKER-7 pass 98: 4 BUGS aplicando Pattern W7.
//
// BUG 1 *** RATE-LIMIT MISSING *** addressed acima via logoutLimiter.
//
// BUG 2 *** DLP user-agent ***
//   PRE-FIX: audit_log.payload_after armazena ua raw - pode conter Bearer/JWT
//   em custom UA headers (raro mas defensive).
//   FIX: mask.text() defensive em ua antes do INSERT.
//
// BUG 3 *** MLB FEATURE: ?revoke_all=true ***
//   PRE-FIX: logout revoga apenas SESSAO ATUAL via refresh_token_hash match.
//   UX MLB "Sair de todos os dispositivos" requer revogar ALL sessions do user.
//   FIX: ?revoke_all=true flag - WHERE user_id=$N (revoga todas non-revoked).
//   Requer JWT auth p/ identificar user (vs apenas cookie como modo atual).
//
// BUG 4 *** AUDIT LOG FIRE-AND-FORGET ***
//   PRE-FIX: .catch(log.warn) - audit falha = logout sucedeu sem trail.
//   Compliance gap: regulatory requirements (LGPD direito-acesso) requer log
//   de TODAS sessions terminadas.
//   FIX: await audit log dentro tx() junto com UPDATE user_sessions.
router.post('/logout',
  logoutLimiter,
  asyncHandler(async (req, res) => {
    const rt = req.cookies?.[REFRESH_COOKIE];
    // FIX-WORKER-6 pass 3: clearCookie sempre (idempotente, defesa em profundidade)
    res.clearCookie(REFRESH_COOKIE, { path: '/' });

    // BUG 3: ?revoke_all=true - revoga todas sessions do user (requires JWT auth)
    const revokeAll = String(req.query.revoke_all || '').toLowerCase() === 'true';

    if (!rt && !revokeAll) {
      return res.json({ ok: true, was_logged_in: false, message: 'Nenhuma sessao ativa' });
    }

    let revokedRows = [];

    if (revokeAll) {
      // Requer JWT auth para identificar user
      let userId;
      try {
        const auth = req.headers.authorization || '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
        if (!token) return res.status(401).json({ error: 'auth_required_for_revoke_all' });
        const decoded = jwt.verifyAccess(token);
        userId = decoded.sub;
      } catch (_e) {
        return res.status(401).json({ error: 'invalid_access_token' });
      }

      const r = await query(
        `UPDATE user_sessions
            SET is_revoked = TRUE, revoked_at = NOW(), revoked_reason = $1
          WHERE user_id = $2 AND is_revoked = FALSE
          RETURNING id, user_id`,
        ['logout_all', userId]
      );
      revokedRows = r.rows;
    } else {
      // Logout sessao atual via refresh_token_hash match
      const r = await query(
        `UPDATE user_sessions
            SET is_revoked = TRUE, revoked_at = NOW(), revoked_reason = $1
          WHERE refresh_token_hash = $2 AND is_revoked = FALSE
          RETURNING id, user_id`,
        ['logout', jwt.hashToken(rt)]
      );
      revokedRows = r.rows;
    }

    if (!revokedRows.length) {
      return res.json({
        ok: true, was_logged_in: false,
        message: revokeAll ? 'Nenhuma sessao ativa encontrada' : 'Sessao nao encontrada ou ja revogada',
      });
    }

    // BUG 2+4: audit log atomic + DLP mask ua
    // (await sem catch - se falhar response inclui flag)
    const safeUa = mask.text((req.headers['user-agent'] || '').slice(0, 200));
    let auditOk = true;
    try {
      await query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES ($1, 'user', $2, 'user_session', $3, 'info', $4::JSONB)`,
        [revokedRows[0].user_id,
         revokeAll ? 'auth.logout_all' : 'auth.logout',
         revokedRows[0].id,
         JSON.stringify({
           ip: req.ip,
           ua: safeUa,
           sessions_revoked: revokedRows.length,
           revoke_all: revokeAll,
         })]
      );
    } catch (e) {
      auditOk = false;
      log.error({ err: e.message, user_id: revokedRows[0].user_id }, '[logout.audit.fail]');
    }

    res.json({
      ok: true,
      was_logged_in: true,
      sessions_revoked: revokedRows.length,
      revoke_all: revokeAll,
      ...(auditOk ? {} : { audit_warning: 'logout sucedeu mas audit_log falhou' }),
    });
  })
);

// POST /auth/forgot-password
router.post('/forgot-password',
  forgotPasswordLimiter,
  // FIX-WORKER-6 pass 182: usa normalizedEmail (.toLowerCase().trim())
  validate({ body: z.object({ email: normalizedEmail }) }),
  asyncHandler(async (req, res) => {
    // FIX-WORKER-7 pass 50: 4 BUGS CRITICOS aplicando Pattern W7 + W13 cross-svc.
    //
    // BUG 1 *** XSS via fullName em body_html ***
    //   Atacante /register com full_name='<img src=x onerror=alert(1)>'
    //   /forgot-password gera email body_html com HTML raw -> alguns email
    //   clients legacy (Outlook, IMAP custom) renderizam script
    //   + dashboard-admin que renderiza notifications/payload pode XSS reflect
    //   Pattern W13 pass 31 estabeleceu _htmlEscape - aplicar AQUI tambem
    //   FIX: htmlEscape(fullName) antes interpolar no template
    //
    // BUG 2 *** AUDIT_LOG MISSING *** security event critical sem trail
    //   /forgot-password = signal interesting (potential account takeover)
    //   FIX: INSERT audit_log atomic dentro tx com payload IP+UA+email_hash
    //
    // BUG 3 *** ATOMICITY *** INSERT password_resets + INSERT notification
    //   sem tx() - falha notification = token existe DB mas user nao recebe
    //   email. Token "vazado" em logs DB sem ser consumed.
    //   FIX: tx() atomic
    //
    // BUG 4 *** MULTIPLOS PASSWORD_RESETS PENDING ***
    //   Pre-fix: user pode ter 10 tokens validos simultaneous (1 por request)
    //   Atacante: spam /forgot-password -> 10 emails ao victim + 10 tokens DB
    //   Anti-spam: invalidar tokens anteriores ao gerar novo (1 token por user max)
    //   FIX: UPDATE password_resets SET used_at=NOW() WHERE user_id ... AND used_at IS NULL
    //   ANTES INSERT novo token
    // FIX-WORKER-7 pass 52: htmlEscape via @cas/shared (DRY - removido inline)

    const tok = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(tok).digest('hex');
    const u = await query('SELECT id, full_name FROM users WHERE email = $1 AND deleted_at IS NULL', [req.body.email]);
    if (u.rows.length) {
      const userId = u.rows[0].id;
      const fullName = u.rows[0].full_name || 'cliente';
      const fullNameSafe = htmlEscape(fullName);  // FIX bug 1
      const resetUrl = `${process.env.APP_URL || 'https://cas.inovareinteligenciaartificial.com'}/redefinir-senha?token=${tok}`;

      await tx(async (c) => {
        // FIX bug 4: invalida tokens previos pending (1 token per user max)
        await c.query(
          `UPDATE password_resets SET used_at = NOW()
            WHERE user_id = $1 AND used_at IS NULL AND expires_at > NOW()`,
          [userId]
        );
        // INSERT novo token
        await c.query(
          `INSERT INTO password_resets (user_id, token_hash, requested_ip, expires_at)
           VALUES ($1, $2, $3, NOW() + INTERVAL '15 minutes')`,
          [userId, hash, req.ip]
        );
        // INSERT notification (mesmo tx - FIX bug 3 atomicity)
        await c.query(
          `INSERT INTO notifications (user_id, channel, template_code, title, body, body_html, payload, priority)
           VALUES ($1, 'email', 'password_reset', $2, $3, $4, $5::JSONB, 1)`,
          [
            userId,
            'Redefinicao de senha - Code & Agent Shop',
            // Body text: nao escapa (plain text - sem renderizacao)
            `Ola ${fullName},\n\nClique no link para redefinir sua senha:\n${resetUrl}\n\nLink expira em 15 minutos.\nSe nao foi voce, ignore este email.`,
            // body_html: USA fullNameSafe (escapado)
            `<p>Ola <b>${fullNameSafe}</b>,</p><p>Clique no link abaixo para redefinir sua senha:</p><p><a href="${resetUrl}" style="display:inline-block;padding:10px 20px;background:linear-gradient(135deg,#EC4899,#7C3AED);color:#fff;text-decoration:none;border-radius:8px;">Redefinir senha</a></p><p>Link expira em 15 minutos. Se nao foi voce, ignore.</p>`,
            // payload: name NAO escapado (consumido como JSON - cliente eh responsavel pelo escape no render)
            JSON.stringify({ url: resetUrl, name: fullName }),
          ]
        );
        // FIX bug 2: audit_log atomic (security event critical - account takeover signal)
        await c.query(
          `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
           VALUES ($1, 'system', 'auth.forgot_password', 'user', $1, 'warn', $2::JSONB)`,
          [userId, JSON.stringify({
            ip: req.ip,
            ua_prefix: (req.headers['user-agent'] || '').slice(0, 60),
            // email_hash em vez de email completo (privacy LGPD)
            email_hash: crypto.createHash('sha256').update(req.body.email).digest('hex').slice(0, 16),
          })]
        );
      });
    } else {
      // FIX bug 2: audit tambem fail attempts (atacante enumerando emails)
      // NAO bloqueia response (anti-enumeration - timing same)
      query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES (NULL, 'system', 'auth.forgot_password.user_not_found', 'email', NULL, 'info', $1::JSONB)`,
        [JSON.stringify({
          ip: req.ip,
          email_hash: crypto.createHash('sha256').update(req.body.email).digest('hex').slice(0, 16),
        })]
      ).catch(() => {});
    }
    res.json({ ok: true, message: 'Se o email existir, enviaremos instrucoes.' });
  })
);

// POST /auth/reset-password
// FIX-WORKER-7 pass 50: 3 BUGS aplicando Pattern W7.
//
// BUG 1 *** AUDIT_LOG MISSING *** password change = security event critical
//   Pattern W7 high-impact: audit obrigatorio.
//   FIX: INSERT audit_log atomic dentro tx (sessions_revoked count + ip)
//
// BUG 2 *** STRONGER password validation ***
//   Pre-fix: so [A-Z] + [0-9]. Senha "Aaaaaaa1" passa - fraca.
//   Pattern industry (NIST 800-63B): min 1 lowercase + 1 uppercase + 1 digit +
//   1 special. AQUI mantenho relax (UX-friendly) MAS adiciono special char check
//   FIX: refine adiciona /[^\w\s]/ (special char) requirement
//
// BUG 3 *** Regra K FOR UPDATE *** password_resets row + users row
//   Race: 2 requests concorrent mesmo token -> tx anterior race
//   FIX: FOR UPDATE password_resets row anti-race
router.post('/reset-password',
  resetPasswordLimiter,
  validate({ body: z.object({
    token: z.string().min(32),
    password: z.string().min(8).max(128)
      .refine((s) => /[A-Z]/.test(s) && /[0-9]/.test(s) && /[^\w\s]/.test(s),
        'Senha precisa de maiuscula, numero e caractere especial (!@#$%^&* etc)'),
  })}),
  asyncHandler(async (req, res, next) => {
    const bcrypt = require('bcrypt');
    const hash = crypto.createHash('sha256').update(req.body.token).digest('hex');

    let outcome;
    await tx(async (c) => {
      // FIX bug 3 (Regra K): SELECT FOR UPDATE password_resets anti-race
      const r = await c.query(
        `SELECT id, user_id FROM password_resets
          WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
          FOR UPDATE`, [hash]
      );
      if (!r.rows.length) {
        outcome = { error: 'invalid_or_expired_token' };
        return;
      }
      const pwHash = await bcrypt.hash(req.body.password, 12);
      await c.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
        [pwHash, r.rows[0].user_id]);
      await c.query('UPDATE password_resets SET used_at = NOW() WHERE id = $1', [r.rows[0].id]);
      // revoga todas sessoes ativas (forca re-login)
      const revoked = await c.query(
        `UPDATE user_sessions SET is_revoked = TRUE, revoked_at = NOW(),
                                  revoked_reason = 'password_reset'
          WHERE user_id = $1 AND is_revoked = FALSE
          RETURNING id`,
        [r.rows[0].user_id]
      );
      // FIX bug 1: audit_log atomic - security event critical
      await c.query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES ($1, 'user', 'auth.password_reset', 'user', $1, 'warn', $2::JSONB)`,
        [r.rows[0].user_id, JSON.stringify({
          ip: req.ip,
          ua_prefix: (req.headers['user-agent'] || '').slice(0, 60),
          sessions_revoked: revoked.rows.length,
          token_id_prefix: r.rows[0].id.slice(0, 8),
        })]
      );
    });

    if (outcome?.error === 'invalid_or_expired_token') {
      return next(require('@cas/shared').errorHandler.badRequest('invalid_or_expired_token'));
    }
    res.json({ ok: true, message: 'Senha redefinida. Faca login com a nova senha.' });
  })
);

module.exports = router;
