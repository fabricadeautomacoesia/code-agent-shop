'use strict';

const express = require('express');
const { query } = require('@cas/db-client');
const { jwt, asyncHandler, errorHandler } = require('@cas/shared');

const router = express.Router();
router.use(jwt.requireAuth());

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

router.patch('/', asyncHandler(async (req, res, next) => {
  // FIX-WORKER-2 pass 5: cpf_cnpj adicionado a whitelist + valida algoritmo.
  // Antes era IMPOSSIVEL user atualizar CPF apos register (campo nao na lista).
  const allowed = ['full_name','display_name','avatar_url','bio','locale','timezone','phone_e164','cpf_cnpj'];
  const cols = [];
  const vals = [];
  let i = 1;
  for (const k of allowed) {
    if (req.body[k] !== undefined) {
      let v = req.body[k];
      // CPF/CNPJ: normaliza apenas digitos + valida algoritmo
      if (k === 'cpf_cnpj' && v) {
        const digits = String(v).replace(/\D/g, '');
        if (digits.length === 11) {
          if (!isValidCpf(digits)) return next(errorHandler.badRequest('invalid_cpf', 'CPF invalido (digitos verificadores nao conferem)'));
        } else if (digits.length === 14) {
          if (!isValidCnpj(digits)) return next(errorHandler.badRequest('invalid_cnpj', 'CNPJ invalido (digitos verificadores nao conferem)'));
        } else {
          return next(errorHandler.badRequest('invalid_cpf_cnpj_length', 'CPF deve ter 11 digitos ou CNPJ 14'));
        }
        v = digits; // armazena normalizado
      }
      cols.push(`${k} = $${i++}`);
      vals.push(v);
    }
  }
  if (!cols.length) return res.json({ ok: true, noop: true });
  vals.push(req.user.sub);
  await query(`UPDATE users SET ${cols.join(', ')}, updated_at = NOW() WHERE id = $${i}`, vals);
  res.json({ ok: true });
}));

module.exports = router;
