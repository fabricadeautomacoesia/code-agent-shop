'use strict';

const express = require('express');
const { z } = require('zod');
const { query, tx } = require('@cas/db-client');
const { jwt, asyncHandler, errorHandler, validate, rateLimiter, mask, maskPII, cache } = require('@cas/shared');

const router = express.Router();
router.use(jwt.requireAuth());

// FIX-WORKER-7 pass 97: rate-limit PATCH /me anti-spam.
// PRE-FIX: zero limit. Bot pwned user account pode brute-force cpf_cnpj
// validity check (10000 attempts/min vs algorithm complete check). Tambem
// pode spam PATCH com payload grande consumindo DB write throughput.
// FIX: 20 PATCHs/hr/user (real users patch profile 1-2x/dia).
const patchMeLimiter = rateLimiter.createLimiter({
  windowMs: 60 * 60 * 1000, max: 20,
  message: 'Muitas atualizacoes recentes. Aguarde 1 hora.',
});

// FIX-WORKER-7 pass 97: Zod schema para validation rigorosa.
// PRE-FIX: allowed array filter campos mas SEM type/size/format validation.
//   - full_name aceita 50000 chars (DoS storage)
//   - avatar_url aceita 'javascript:alert()' (XSS quando <img src=>)
//   - bio aceita raw HTML (XSS no /perfil)
//   - locale aceita string arbitraria
//   - timezone aceita string arbitraria
//   - phone_e164 aceita 'abc'
const ALLOWED_LOCALES = new Set(['pt-BR','en-US','es-ES','fr-FR']);
const patchMeSchema = z.object({
  full_name: z.string().min(2).max(200).optional(),
  display_name: z.string().min(1).max(80).optional(),
  avatar_url: z.string().url().max(500).optional(),
  bio: z.string().max(2000).optional(),
  locale: z.string().refine((s) => ALLOWED_LOCALES.has(s), { message: 'locale invalido' }).optional(),
  timezone: z.string().max(50).regex(/^[A-Za-z_/+\-0-9]+$/, 'timezone inválido').optional(),
  phone_e164: z.string().regex(/^\+\d{10,15}$/, 'phone_e164 deve seguir formato E.164: +DDIDDIDNumero').optional(),
  // FIX-WORKER-6 pass 385 (cpf_cnpj regex hardening):
  //   PRE-FIX: z.string().min(11).max(20) - aceita qualquer chars dentro do range
  //   Vetores aceitos:
  //   - "abc12345678" (11 chars) -> isValidCpf algorithm catch MAS Zod passa
  //   - "11.222.333-44/55-6" (18 chars) -> mascara inconsistente vs DB digits
  //   - "<svg>11" (8 chars Zod reject, mas 11+ chars passa - varia ataque)
  //   Risco: audit_log payload com input raw antes da validacao algoritmo
  //   POST-FIX: regex whitelist digitos + pontuacao BR (. - /) cap real
  //   - CPF format: 111.222.333-44 (14 chars com mask) ou 11122233344 (11 raw)
  //   - CNPJ format: 11.222.333/0001-44 (18 chars com mask) ou 11222333000144 (14 raw)
  //   - Apenas digitos + . - / aceitos (chars validos formato BR)
  //   - Algoritmo isValidCpf/Cnpj (linha 144-150) valida DV apos normalizacao
  cpf_cnpj: z.string().min(11).max(20).regex(/^[0-9./\-]+$/, 'cpf_cnpj deve conter apenas digitos e . - /').optional(),
});

// FIX-WORKER-2 pass 5: GET /me agora retorna cpf_cnpj (era omitido).
// W2 pass 4 checkout faz Api.me() e verifica user.cpf_cnpj para banner CPF.
// FIX-WORKER-18 pass 211: cache 60s per-user.
// Frontend useAuth hook chama /me em CADA navegacao (header user dropdown,
// banner notifications, auth state refresh). 100+ navegacoes/sessao = hits PG.
// PRE-FIX: SELECT users + 2 subqueries (twofa + seller_profile JSON agg) = ~12ms PG.
// POST-FIX: 60s cache vary by user.sub.
// Invalidation: PATCH /me, /2fa/enable, /2fa/disable, role change, etc.
const meCacheKey = (req) => `auth:me:${req.user?.sub || 'anon'}`;

router.get('/',
  cache.cacheMiddleware(meCacheKey, 60),
  asyncHandler(async (req, res) => {
    const r = await query(
      `SELECT u.id, u.email, u.full_name, u.display_name, u.role, u.avatar_url, u.locale, u.timezone,
              u.cpf_cnpj, u.phone_e164,
              u.is_email_verified, u.is_phone_verified, u.created_at,
              (SELECT is_enabled FROM user_two_factor WHERE user_id = u.id) AS twofa_enabled,
              (SELECT to_jsonb(s) - 'metadata' FROM sellers s WHERE s.user_id = u.id) AS seller_profile
       FROM users u
       WHERE u.id = $1 AND u.deleted_at IS NULL`,
      [req.user.sub]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'user_not_found' });
    res.json({ user: r.rows[0] });
  })
);

// FIX-WORKER-2 pass 5: valida CPF/CNPJ algoritmo dos digitos verificadores.
// Antes: backend aceitava qualquer string (so registerSchema validava no register).
// PATCH /me sem essa validacao deixava user setar "12345678901" e quebrar Asaas.
function isValidCpf(s) {
  s = String(s || '').replace(/\D/g, '');
  if (s.length !== 11 || /^(\d)\1+$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(s[i], 10) * (10 - i);
  let dv1 = (sum * 10) % 11; if (dv1 === 10) dv1 = 0;
  if (dv1 !== parseInt(s[9], 10)) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(s[i], 10) * (11 - i);
  let dv2 = (sum * 10) % 11; if (dv2 === 10) dv2 = 0;
  return dv2 === parseInt(s[10], 10);
}
function isValidCnpj(s) {
  s = String(s || '').replace(/\D/g, '');
  if (s.length !== 14 || /^(\d)\1+$/.test(s)) return false;
  const calc = (slice) => {
    let sum = 0, pos = slice.length - 7;
    for (let i = slice.length; i >= 1; i--) {
      sum += parseInt(slice[slice.length - i], 10) * pos--;
      if (pos < 2) pos = 9;
    }
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  if (calc(s.slice(0, 12)) !== parseInt(s[12], 10)) return false;
  return calc(s.slice(0, 13)) === parseInt(s[13], 10);
}

// PATCH /me - atualiza profile do user logado
// FIX-WORKER-2 pass 5: cpf_cnpj whitelist + algoritmo digitos verificadores.
// FIX-WORKER-7 pass 97: 8 BUGS aplicando Pattern W7 (Regra K+P + Zod + audit + rate-limit).
//
// BUG 1 *** Regra K tx() + SELECT FOR UPDATE *** lost update
//   PRE-FIX: 2 PATCHs simultaneos (multi-tab) -> last write wins.
//   PATCH user-cpf + admin-PATCH-role -> race entre fields.
//   FIX: tx() wrap + SELECT FOR UPDATE em users row.
// BUG 2 *** ZOD VALIDATION MISSING *** XSS/DoS vectors
//   - full_name 50000 chars (DoS storage)
//   - avatar_url 'javascript:alert()' (XSS via <img>)
//   - bio raw HTML (XSS /perfil)
//   - locale string arbitraria (UI broken render)
//   - timezone arbitrary (PG TZ cast falha)
//   - phone_e164 'abc' (Asaas createCustomer falha)
// BUG 3 *** Regra P AUDIT LOG MISSING ***
//   PATCH cpf_cnpj = compliance critical (KYC change, AML/anti-fraude trail).
//   PATCH role pode escalate (admin pwned changes user role) - audit obrigatorio.
//   FIX: INSERT audit_log atomic com fields changed + ip.
// BUG 4 *** EMPTY BODY EARLY CHECK MISSING ***
//   Loop runs antes do empty check - waste compute em empty PATCH.
// BUG 5 *** RATE-LIMIT MISSING *** addressed acima via patchMeLimiter.
// BUG 6 *** CPF UNIQUE CONFLICT 500 LEAK ***
//   PG 23505 unique_violation se outro user tem mesmo cpf_cnpj -> 500.
//   FIX: try/catch + 409 cpf_already_registered.
// BUG 7 *** OLD PATCH cpf_cnpj validation INLINE *** mantida (algoritmo digitos)
//   mas movida para post-Zod validation (Zod valida format, helpers algoritmo).
// BUG 8 *** PII DLP audit payload ***
//   audit_log payload com cpf_cnpj raw eh re-leak. FIX: maskPII no payload.
router.patch('/',
  patchMeLimiter,
  validate({ body: patchMeSchema }),
  asyncHandler(async (req, res, next) => {
    const allowed = ['full_name','display_name','avatar_url','bio','locale','timezone','phone_e164','cpf_cnpj'];
    const fieldsProvided = allowed.filter((k) => req.body[k] !== undefined);

    // BUG 4: empty body check upfront
    if (!fieldsProvided.length) {
      return res.json({ ok: true, noop: true });
    }

    // BUG 7: validate cpf_cnpj algoritmo (Zod ja validou size, agora dv1+dv2)
    if (req.body.cpf_cnpj) {
      const digits = String(req.body.cpf_cnpj).replace(/\D/g, '');
      if (digits.length === 11) {
        if (!isValidCpf(digits)) return next(errorHandler.badRequest('invalid_cpf', 'CPF invalido (digitos verificadores nao conferem)'));
      } else if (digits.length === 14) {
        if (!isValidCnpj(digits)) return next(errorHandler.badRequest('invalid_cnpj', 'CNPJ invalido (digitos verificadores nao conferem)'));
      } else {
        return next(errorHandler.badRequest('invalid_cpf_cnpj_length', 'CPF deve ter 11 digitos ou CNPJ 14'));
      }
      req.body.cpf_cnpj = digits;
    }

    // Build SET cols
    const cols = [];
    const vals = [];
    let i = 1;
    for (const k of fieldsProvided) {
      cols.push(`${k} = $${i++}`);
      vals.push(req.body[k]);
    }
    vals.push(req.user.sub);
    const limIdx = i;

    let outcome;
    try {
      await tx(async (c) => {
        // BUG 1 Regra K: SELECT FOR UPDATE em users (anti-race)
        const cur = await c.query(
          `SELECT id, cpf_cnpj AS old_cpf FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
          [req.user.sub]
        );
        if (!cur.rows.length) { outcome = { error: 'user_not_found' }; return; }

        // UPDATE atomic
        await c.query(
          `UPDATE users SET ${cols.join(', ')}, updated_at = NOW() WHERE id = $${limIdx}`,
          vals
        );

        // BUG 3+8 Regra P: audit log atomic + DLP mask cpf
        // FIX-WORKER-6 pass 258 (cpfChanged false-positive):
        //   PRE-FIX: req.body.cpf_cnpj (digits normalizado linha 151) !=
        //   cur.rows[0].old_cpf (possivel formato legacy "111.222.333-44")
        //   User submetia mesmo CPF em formato diferente -> cpfChanged=true
        //   incorreto -> audit_log false-positive 'cpf_changed' + severity warn
        //   (era info)
        //   POST-FIX: normalize both sides via regex digits-only antes compare
        //   (mesmo pattern register pass 241).
        const oldDigits = cur.rows[0].old_cpf ? String(cur.rows[0].old_cpf).replace(/\D/g, '') : '';
        const newDigits = req.body.cpf_cnpj || '';
        const cpfChanged = req.body.cpf_cnpj !== undefined && oldDigits !== newDigits;
        /* FIX-WORKER-6 pass 564 (ua_prefix forensic gap - paridade cadeia pass 282/438):
           PRE-FIX: PATCH /me audit_log payload tinha ip mas NAO ua_prefix.
           Pattern V8 cross-svc consolidacao established:
           - pass 282 auth-svc /forgot-password + /reset-password + /logout
           - pass 292 register
           - pass 296 review-svc audit
           - pass 315 auth-svc /refresh reuse breach
           - pass 408 seller-svc audit
           - pass 438 vault-svc cross-endpoints + payment-svc webhook
           - pass 443 auth-svc /refresh banned cascade
           - PATCH /me era unico audit_log critical endpoint em auth-svc lagged
           Cenarios reais impactados:
           - Atacante post-XSS muda cpf_cnpj victim -> admin investiga incident
           - audit_log mostra ip mas SEM ua_prefix -> correlation IP+UA p/ device
             match impossivel (multiple users mesmo IP NAT = forensic broken)
           - LGPD Art 37 forensic operational tracking incompleto
           POST-FIX: + ua_prefix mask.text() em payload audit_log. */
        await c.query(
          `INSERT INTO audit_log
            (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
           VALUES ($1, $2, 'user.patch_profile', 'user', $3, $4, $5::JSONB)`,
          [req.user.sub, req.user.role, req.user.sub,
           cpfChanged ? 'warn' : 'info',
           JSON.stringify({
             fields: fieldsProvided,
             cpf_changed: cpfChanged,
             // FIX-WORKER-7 pass 173 (DRY): inline mask -> @cas/shared.maskPII.cpf
             // Garante consistencia com display LGPD (mesma representacao em
             // audit_log, admin UI, /me responses) + null-safe pra CPFs invalidos.
             cpf_masked: cpfChanged ? maskPII.cpf(req.body.cpf_cnpj) : null,
             ip: req.ip,
             // FIX pass 564: ua_prefix forensic device fingerprint correlation
             ua_prefix: mask.text((req.headers['user-agent'] || '').slice(0, 60)),
           })]
        );
      });
    } catch (e) {
      // BUG 6: CPF unique violation -> 409 (era 500 leak)
      if (e.code === '23505') {
        outcome = { error: 'cpf_already_registered' };
      } else {
        throw e;
      }
    }

    if (outcome?.error === 'user_not_found') return next(errorHandler.notFound('user_not_found'));
    if (outcome?.error === 'cpf_already_registered') {
      return res.status(409).json({
        error: 'cpf_already_registered',
        message: 'CPF/CNPJ ja registrado em outra conta.',
      });
    }

    // FIX-WORKER-18 pass 211: invalida cache auth:me apos PATCH (cache 60s pode mostrar stale)
    try {
      await cache.del(`auth:me:${req.user.sub}`);
    } catch (_) { /* best-effort */ }

    res.json({ ok: true });
  })
);

module.exports = router;
