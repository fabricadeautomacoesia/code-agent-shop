'use strict';

/**
 * @cas/shared.maskPII - LGPD data-minimization PII display masking.
 *
 * FIX-WORKER-7 pass 58: Extract dos helpers locais maskEmail/maskName
 * duplicados em review-svc/src/server.js (pass 56/57).
 *
 * SEMANTIC SEPARATION:
 *   mask.js   = DLP secret masking em LOGS (sk-, Bearer, JWT, CPF/CNPJ regex)
 *   mask-pii.js = LGPD PII display masking em API RESPONSES (role-tier visibility)
 *
 * USAGE PATTERN (role-tier):
 *   const isAdmin = req.user && req.user.role === 'admin';
 *   const rows = result.map((r) => isAdmin ? r : {
 *     ...r,
 *     buyer_email: maskPII.email(r.buyer_email),
 *     buyer_name:  maskPII.name(r.buyer_name),
 *   });
 *
 * NULL-SAFE: todos retornam null/'' p/ input vazio (sem throw).
 */

/**
 * Email masking p/ display LGPD-safe.
 * Examples:
 *   'jo***@email.com'        <- 'joao@email.com'
 *   '***@email.com'          <- 'a@email.com' (local < 2 chars)
 *   null                     <- null
 *   ''                       <- null
 */
function email(input) {
  if (!input || typeof input !== 'string') return null;
  const at = input.indexOf('@');
  if (at < 0) {
    // Nao parece email - mask preservando prefixo p/ debug
    return input.length <= 2 ? '***' : input.slice(0, 2) + '***';
  }
  if (at < 2) return '***' + input.slice(at);
  return input.slice(0, 2) + '***' + input.slice(at);
}

/**
 * Nome masking p/ display LGPD-safe.
 * Examples:
 *   'Jo***'                  <- 'Joao Silva'
 *   'J***'                   <- 'Ji'  (len <= 2)
 *   null                     <- null
 */
function name(input) {
  if (!input || typeof input !== 'string') return null;
  return input.length <= 2 ? input[0] + '***' : input.slice(0, 2) + '***';
}

/**
 * CPF masking p/ display LGPD-safe.
 * Examples:
 *   '123.***.**8-90'         <- '12345678890' (raw) ou '123.456.789-90'
 *   null                     <- null
 *
 * Preserva 3 primeiros + 2 ultimos digitos (padrao Receita Federal).
 */
function cpf(input) {
  if (!input || typeof input !== 'string') return null;
  const digits = input.replace(/\D/g, '');
  if (digits.length < 5) return '***';
  return digits.slice(0, 3) + '.***.***-' + digits.slice(-2);
}

/**
 * Telefone masking p/ display LGPD-safe.
 * Examples:
 *   '(11) ****-**89'         <- '11987654389'
 *   null                     <- null
 */
function phone(input) {
  if (!input || typeof input !== 'string') return null;
  const digits = input.replace(/\D/g, '');
  if (digits.length < 4) return '***';
  const ddd = digits.length >= 10 ? digits.slice(0, 2) : '';
  const last = digits.slice(-2);
  return ddd ? `(${ddd}) ****-**${last}` : `****-**${last}`;
}

/**
 * Mask shorthand p/ object: aplica masks por field comuns.
 * Use quando rows tem padronizadas keys (buyer_email, buyer_name, etc).
 *
 * Example:
 *   rows.map((r) => maskPII.row(r, ['buyer_email','buyer_name']))
 *
 * Suffix-based detection (auto):
 *   *_email -> email()  |  *_name -> name()  |  *_cpf -> cpf()  |  *_phone -> phone()
 */
function row(input, fields) {
  if (!input || typeof input !== 'object') return input;
  if (!Array.isArray(fields) || !fields.length) return input;
  const out = { ...input };
  for (const f of fields) {
    if (out[f] == null) continue;
    if (f.endsWith('_email') || f === 'email') out[f] = email(out[f]);
    else if (f.endsWith('_name') || f === 'name') out[f] = name(out[f]);
    else if (f.endsWith('_cpf') || f === 'cpf' || f.endsWith('_document')) out[f] = cpf(out[f]);
    else if (f.endsWith('_phone') || f === 'phone') out[f] = phone(out[f]);
  }
  return out;
}

module.exports = { email, name, cpf, phone, row };
