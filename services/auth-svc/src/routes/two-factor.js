'use strict';

const express = require('express');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const bcrypt = require('bcrypt');
const crypto = require('node:crypto');
const { query, tx } = require('@cas/db-client');
const { jwt, validate, asyncHandler, errorHandler, crypto: cryp, cache, mask, notifCache } = require('@cas/shared');

// FIX-WORKER-7 pass 54: REFRESH_COOKIE constante p/ clearCookie em /disable.
// Mesmo valor de auth.js linha 65 - duplicado por design (modulo standalone).
// TODO refactor: extrair p/ @cas/shared.authConstants OU passar via req.app.locals
const REFRESH_COOKIE = 'cas_rt';

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
// FIX-WORKER-7 pass 55: 2 BUGS - bypass 2FA via setup + audit missing.
//
// BUG 1 *** BYPASS 2FA VIA SETUP *** ON CONFLICT UPDATE sobrescreve enabled
//   PRE-FIX: ON CONFLICT (user_id) DO UPDATE SET ... is_enabled=FALSE
//   Se user JA TEM 2FA enabled, /setup silenciosamente:
//     a. Sobrescreve secret_encrypted (novo secret)
//     b. SET is_enabled = FALSE (DESATIVA 2FA!)
//   ATAQUE:
//     T0: User com 2FA ativo + password phishada (atacante tem cookie session)
//     T1: Atacante POST /2fa/setup -> 2FA disabled silenciosamente
//     T2: Atacante /login so password -> sucesso (2FA off)
//     T3: BYPASS 2FA via setup endpoint (mesmo objetivo pass 54 /disable bug
//         mas via outra rota - paralelo defesa)
//   FIX: rejeitar /setup se ja enabled - usuario deve /disable primeiro
//   (exige password + TOTP - prova posse)
//
// BUG 2 *** AUDIT_LOG missing *** setup 2FA = security event
//   Setup = atacante interno preparing bypass OR user legitimate re-config
//   FIX: INSERT audit_log severity warn
router.post('/setup', totpSetupLimiter, asyncHandler(async (req, res, next) => {
  // BUG 1 FIX: check status atual ANTES INSERT/UPDATE
  const cur = await query(
    'SELECT is_enabled FROM user_two_factor WHERE user_id = $1',
    [req.user.sub]
  );
  if (cur.rows.length && cur.rows[0].is_enabled) {
    return res.status(409).json({
      error: 'already_enabled',
      message: '2FA ja esta ativo. Use /2fa/disable primeiro (exige senha + token atual).',
    });
  }

  const secret = authenticator.generateSecret();
  const { encrypted, iv, tag } = cryp.encrypt(secret);

  await tx(async (c) => {
    await c.query(
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
    // BUG 2 FIX: audit_log atomic
    await c.query(
      `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
       VALUES ($1, 'user', '2fa.setup', 'user', $1, 'info', $2::JSONB)`,
      [req.user.sub, JSON.stringify({
        ip: req.ip,
        /* FIX-WORKER-6 pass 296: ua_prefix mask.text() paridade pass 282/292 cross-svc DLP */
          ua_prefix: mask.text((req.headers['user-agent'] || '').slice(0, 60)),
        re_setup: cur.rows.length > 0,  // primeira vez OR re-config pos-disable
      })]
    );
  });

  const otpauth = authenticator.keyuri(req.user.email, process.env.TOTP_ISSUER || 'CodeAgentShop', secret);
  const qr = await QRCode.toDataURL(otpauth);
  res.json({ qr_data_url: qr, otpauth, manual_code: secret });
}));

// POST /auth/2fa/activate -> ativa apos primeiro token correto
// FIX-WORKER-7 pass 54: 2 BUGS aplicando Pattern W7 (consistencia pass 49).
//
// BUG 1 *** authenticator.check sem window *** (mesmo bug /login pass 49)
//   PRE-FIX: default window=0 - false-reject por clock drift -> UX "codigo errado"
//   FIX: { window: 1 } = ±1 step (90s tolerance)
//
// BUG 2 *** AUDIT_LOG missing *** enrollment 2FA = SEC EVENT critical
//   FIX: INSERT audit_log atomic
router.post('/activate',
  totpVerifyLimiter,
  validate({ body: z.object({ token: z.string().length(6) }) }),
  asyncHandler(async (req, res, next) => {
    const r = await query('SELECT secret_encrypted, secret_iv, secret_tag FROM user_two_factor WHERE user_id = $1', [req.user.sub]);
    if (!r.rows.length || !r.rows[0].secret_tag) return next(errorHandler.notFound('not_set_up'));
    const secret = cryp.decrypt({ encrypted: r.rows[0].secret_encrypted, iv: r.rows[0].secret_iv, tag: r.rows[0].secret_tag });
    // FIX bug 1: window=1 (consistencia pass 49 /login)
    if (!authenticator.check(req.body.token, secret, { window: 1 })) {
      // FIX-WORKER-6 pass 429 (audit + fail2ban gap PARIDADE /recovery pass 239 + /disable pass 429):
      //   /activate brute-force = atacante com session ativa tenta forjar token TOTP
      //   p/ ativar 2FA com app proprio (account takeover signal).
      //   Token 6 dig = 1M combinacoes - fail2ban limit IPs com >5 tentativas inviabiliza.
      //   Severity warn (not critical) - /activate menos perigoso que /disable mas
      //   ainda merece forensic trail.
      req.fail2ban?.reportFailure();
      query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES ($1, 'user', '2fa.activate.invalid_token', 'user', $1, 'warn', $2::JSONB)`,
        [req.user.sub, JSON.stringify({
          ip: req.ip,
          ua_prefix: mask.text((req.headers['user-agent'] || '').slice(0, 60)),
        })]
      ).catch(() => {});
      return next(errorHandler.badRequest('invalid_token'));
    }

    const recovery = Array.from({ length: 10 }, () => crypto.randomBytes(5).toString('hex'));
    const hashed = await Promise.all(recovery.map((r) => bcrypt.hash(r, 10)));
    // FIX bug 2: tx() atomic UPDATE + audit_log
    // FIX-WORKER-6 pass 372 (notification gap - paridade /recovery pass 220):
    //   PRE-FIX: /activate so audit_log, sem notification cross-device.
    //   /recovery (pass 220) JA notificava priority 2 anti-takeover signal.
    //   /disable (pass 286) JA notificava priority 3.
    //   /activate ficou lagged - sec event "2FA ativado em sua conta" NUNCA enviado.
    //   Cenario fraude (account takeover incompleto):
    //   1. Atacante captura sessao (XSS/MITM)
    //   2. User sem 2FA pre-ativo
    //   3. Atacante setup + activate 2FA com seu app
    //   4. User proximo login -> 2FA ativo (nao configurado por ele!)
    //   5. User perde acesso sem warning + recovery codes nas maos atacante
    //   POST-FIX: notification priority 2 (alta - mudou setting seguranca).
    //   Paridade industry GitHub/AWS: TODA mudanca 2FA notifica todos devices.
    await tx(async (c) => {
      await c.query(
        `UPDATE user_two_factor SET is_enabled = TRUE, enabled_at = NOW(), recovery_codes_hash = $1::JSONB WHERE user_id = $2`,
        [JSON.stringify(hashed), req.user.sub]
      );
      await c.query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES ($1, 'user', '2fa.activate', 'user', $1, 'warn', $2::JSONB)`,
        [req.user.sub, JSON.stringify({ ip: req.ip, /* FIX-WORKER-6 pass 296: ua_prefix mask.text() paridade pass 282/292 cross-svc DLP */
          ua_prefix: mask.text((req.headers['user-agent'] || '').slice(0, 60)), recovery_codes_count: 10 })]
      );
      // FIX pass 372: notification cross-device anti-takeover (paridade /recovery pass 220)
      await c.query(
        `INSERT INTO notifications (user_id, channel, template_code, title, body, priority)
         VALUES ($1, 'in_app', '2fa_activated',
                 'Autenticacao em 2 fatores ativada',
                 'A autenticacao 2FA foi ativada em sua conta. Se nao foi voce, troque sua senha imediatamente e desative 2FA via codigos de recuperacao.',
                 2)`,
        [req.user.sub]
      );
    });
    // FIX-WORKER-18 pass 211: invalida cache auth:me (twofa_enabled mudou)
    // FIX-WORKER-13 pass 467: + notifCache.invalidate apos INSERT notification cross-svc
    //   PRE-FIX: cross-svc INSERT notifications sem invalidate notification-svc cache
    //   - User em outra tab com bell aberto NAO via 2fa_activated alert
    //   - Cache 20s TTL persiste lista stale - CRITICAL security alert delayed
    //   - notification-svc /prefs (pass 459) ja invalidava SEU proprio path
    //   - Cross-svc INSERT lagged ate pass 467 helper consolidacao
    //   POST-FIX: notifCache.invalidate(userId) - shared helper DRY
    await Promise.all([
      cache.del(`auth:me:${req.user.sub}`).catch(() => {}),
      notifCache.invalidate(req.user.sub),
    ]);
    res.json({ enabled: true, recovery_codes: recovery, warn: 'Guarde estes codigos. Nao serao mostrados novamente.' });
  })
);

// FIX-WORKER-6 pass 2: POST /auth/2fa/recovery - regenera codigos de recuperacao
// Exige senha + token TOTP atual (mesmo nivel de seguranca de /disable).
// Substitui os 10 codigos antigos (que podem ter sido perdidos/usados).
// V8 4.2: alto risco -> mesmo gate de seguranca que disable.
// POST /auth/2fa/recovery - regenera codigos recovery
// FIX-WORKER-7 pass 55: 3 BUGS aplicando Pattern W7.
//
// BUG 1 *** authenticator.check sem window *** (consistencia /login + /activate + /disable)
//   FIX: { window: 1 } = ±1 step 90s tolerance
//
// BUG 2 *** AUDIT_LOG missing *** sec event critical (recovery codes regen)
//   FIX: INSERT audit_log severity warn (account takeover signal)
//
// BUG 3 *** Notification user MISSING *** UX cross-device sync
//   Se atacante regen recovery codes, user com sessao ativa em outro device
//   precisa ser notified (anti-account-takeover detection)
//   FIX: INSERT notification priority 2
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
    // BUG 1 FIX: window=1 (consistencia)
    if (!authenticator.check(req.body.token, secret, { window: 1 })) {
      // FIX-WORKER-6 pass 239 (audit + fail2ban gap):
      //   /recovery endpoint regenera recovery codes 2FA. Token invalido aqui
      //   = potencial account takeover attempt (atacante tem password mas nao
      //   o segundo factor). Login path ja fail2ban + audit_log critical, mas
      //   /recovery NAO tinha audit_log nem reportFailure -> brute force gap.
      //   POST-FIX: paridade com /login auth.js:325 - fail2ban + audit critical.
      req.fail2ban?.reportFailure();
      query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES ($1, 'user', '2fa.recovery.invalid_token', 'user', $1, 'critical', $2::JSONB)`,
        [req.user.sub, JSON.stringify({
          ip: req.ip,
          /* FIX-WORKER-6 pass 296: ua_prefix mask.text() paridade pass 282/292 cross-svc DLP */
          ua_prefix: mask.text((req.headers['user-agent'] || '').slice(0, 60)),
        })]
      ).catch(() => {});
      return next(errorHandler.unauthorized('invalid_token'));
    }

    const recovery = Array.from({ length: 10 }, () => crypto.randomBytes(5).toString('hex'));
    const hashed = await Promise.all(recovery.map((c) => bcrypt.hash(c, 10)));
    // BUG 2+3 FIX: tx() atomic UPDATE + audit + notification
    await tx(async (c) => {
      await c.query(
        `UPDATE user_two_factor SET recovery_codes_hash = $1::JSONB, updated_at = NOW() WHERE user_id = $2`,
        [JSON.stringify(hashed), req.user.sub]
      );
      await c.query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES ($1, 'user', '2fa.recovery_regenerated', 'user', $1, 'warn', $2::JSONB)`,
        [req.user.sub, JSON.stringify({
          ip: req.ip,
          /* FIX-WORKER-6 pass 296: ua_prefix mask.text() paridade pass 282/292 cross-svc DLP */
          ua_prefix: mask.text((req.headers['user-agent'] || '').slice(0, 60)),
          codes_count: 10,
        })]
      );
      await c.query(
        `INSERT INTO notifications (user_id, channel, template_code, title, body, priority)
         VALUES ($1, 'in_app', '2fa_recovery_regen',
                 'Codigos de recuperacao 2FA regenerados',
                 'Os codigos de recuperacao 2FA da sua conta foram regenerados. Se nao foi voce, troque sua senha imediatamente.',
                 2)`,
        [req.user.sub]
      );
    });
    // FIX-WORKER-1 pass 471 (notifCache cross-svc - 2fa_recovery_regen anti-takeover)
    notifCache.invalidate(req.user.sub);
    res.json({ recovery_codes: recovery, warn: 'Codigos antigos invalidados. Guarde os novos com seguranca.' });
  })
);

// POST /auth/2fa/disable -> exige senha + token (V8 4.2)
// FIX-WORKER-6 pass 3: idempotente. Se ja desabilitado, valida senha (gate de
// auth pra nao vazar estado) e retorna 200 enabled:false. Antes retornava 404
// "2fa_not_enabled" que confundia o frontend (UI mostrava erro generico).
// Token TOTP nao e exigido nesse caso porque nao ha secret valido.
// POST /auth/2fa/disable
// FIX-WORKER-7 pass 54: 3 BUGS CRITICOS - 2FA disable = SEC EVENT MAXIMO.
//
// BUG 1 *** SESSIONS NAO REVOGADAS *** apos disable 2FA
//   PRE-FIX: UPDATE is_enabled=FALSE + return (sessions ativas mantidas)
//   Cenario: user com 2FA ativo + sessao device A (autenticou COM 2FA)
//   User disable 2FA device B (autenticou COM password+token)
//   Device A: sessao continua valida MAS conta agora SEM 2FA
//   Pattern industry (GitHub/AWS/Google): disable 2FA = revoke ALL sessions
//   Force re-login -> user re-prove identidade pre-2FA-off
//   FIX: revoga todas user_sessions ativas + clearCookie (forca re-login)
//
// BUG 2 *** AUDIT_LOG missing *** disable 2FA = SEC EVENT CRITICAL
//   Pattern W7 high-impact: account takeover risk se atacante consegue disable
//   FIX: INSERT audit_log severity 'critical' (admin alert)
//
// BUG 3 *** authenticator.check sem window *** (mesmo bug /login + /activate)
//   FIX: { window: 1 }
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
    const secret = cryp.decrypt({ encrypted: r.rows[0].secret_encrypted, iv: r.rows[0].secret_iv, tag: r.rows[0].secret_tag });
    // FIX bug 3: window=1 (consistencia /login + /activate)
    if (!authenticator.check(req.body.token, secret, { window: 1 })) {
      // FIX-WORKER-6 pass 429 (audit + fail2ban gap PARIDADE pass 239 /recovery):
      //   /disable e endpoint security-critical: account takeover potential.
      //   Atacante com password phishada pode brute-force TOTP /disable.
      //   /recovery (pass 239) ja tinha fail2ban + audit critical em invalid_token.
      //   /disable lagged ate agora - mesmo vetor SEM forensic trail.
      //   POST-FIX: paridade pass 239 - fail2ban.reportFailure() + audit critical.
      //   Pattern V8 W6: TODO 2FA endpoint security-critical em invalid_token =
      //   fail2ban (escalate bruteforce) + audit_log critical (forensics) + DLP.
      req.fail2ban?.reportFailure();
      query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES ($1, 'user', '2fa.disable.invalid_token', 'user', $1, 'critical', $2::JSONB)`,
        [req.user.sub, JSON.stringify({
          ip: req.ip,
          ua_prefix: mask.text((req.headers['user-agent'] || '').slice(0, 60)),
        })]
      ).catch(() => {});
      return next(errorHandler.unauthorized('invalid_token'));
    }

    // FIX bug 1+2: tx() atomic - disable + revoke sessions + audit_log
    let revokedCount = 0;
    await tx(async (c) => {
      await c.query(
        `UPDATE user_two_factor SET is_enabled = FALSE, disabled_at = NOW() WHERE user_id = $1`,
        [req.user.sub]
      );
      // BUG 1 FIX: revoga TODAS sessions ativas (force re-login pos-2FA-off)
      const revoked = await c.query(
        `UPDATE user_sessions SET is_revoked = TRUE, revoked_at = NOW(),
                                   revoked_reason = '2fa_disabled'
          WHERE user_id = $1 AND is_revoked = FALSE
          RETURNING id`,
        [req.user.sub]
      );
      revokedCount = revoked.rows.length;
      // BUG 2 FIX: audit_log atomic severity critical (sec event maximo)
      await c.query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES ($1, 'user', '2fa.disable', 'user', $1, 'critical', $2::JSONB)`,
        [req.user.sub, JSON.stringify({
          ip: req.ip,
          /* FIX-WORKER-6 pass 296: ua_prefix mask.text() paridade pass 282/292 cross-svc DLP */
          ua_prefix: mask.text((req.headers['user-agent'] || '').slice(0, 60)),
          sessions_revoked: revokedCount,
        })]
      );
      // Notification user (alta prioridade - sec event)
      await c.query(
        `INSERT INTO notifications (user_id, channel, template_code, title, body, priority)
         VALUES ($1, 'in_app', '2fa_disabled',
                 '2FA desativado em sua conta',
                 'A autenticacao de dois fatores foi desativada. Se nao foi voce, troque sua senha imediatamente. Todas as suas sessoes foram encerradas.',
                 3)`,
        [req.user.sub]
      );
    });
    /* FIX-WORKER-1 pass 471 (notifCache cross-svc 2fa_disabled - priority 3 critical):
       2fa_disabled e priority 3 (maximo) - anti-takeover signal.
       User outras sessoes (revogadas) precisam ver IMEDIATO em outras tabs ativas
       que ainda nao receberam re-login force (rare race window).
       Promise.all unified com auth:me invalidation existing. */
    await Promise.all([
      cache.del(`auth:me:${req.user.sub}`),
      notifCache.invalidate(req.user.sub),
    ]).catch(() => {});
    // Clear cookie current session (force re-login)
    res.clearCookie(REFRESH_COOKIE, { path: '/' });
    res.json({ enabled: false, sessions_revoked: revokedCount, warn: 'Todas suas sessoes foram encerradas. Faca login novamente.' });
  })
);

module.exports = router;
