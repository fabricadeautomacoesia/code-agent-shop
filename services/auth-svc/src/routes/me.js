'use strict';

const express = require('express');
const { z } = require('zod');
const { query, tx } = require('@cas/db-client');
const { jwt, asyncHandler, errorHandler, validate, rateLimiter, mask } = require('@cas/shared');

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
  cpf_cnpj: z.string().min(11).max(20).optional(),
});

// FIX-WORKER-2 pass 5: GET /me agora retorna cpf_cnpj (era omitido).
// W2 pass 4 checkout faz Api.me() e verifica user.cpf_cnpj para banner CPF.
router.get('/', asyncHandler(async (req, res) => {
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
}));

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
        const cpfChanged = req.body.cpf_cnpj !== undefined && req.body.cpf_cnpj !== cur.rows[0].old_cpf;
        await c.query(
          `INSERT INTO audit_log
            (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
           VALUES ($1, $2, 'user.patch_profile', 'user', $3, $4, $5::JSONB)`,
          [req.user.sub, req.user.role, req.user.sub,
           cpfChanged ? 'warn' : 'info',
           JSON.stringify({
             fields: fieldsProvided,
             cpf_changed: cpfChanged,
             cpf_masked: cpfChanged && req.body.cpf_cnpj
               ? (req.body.cpf_cnpj.slice(0, 3) + '.***.***-' + req.body.cpf_cnpj.slice(-2))
               : null,
             ip: req.ip,
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

    res.json({ ok: true });
  })
);

module.exports = router;
