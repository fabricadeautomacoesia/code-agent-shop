'use strict';

/**
 * FIX-WORKER-7 pass 52: HTML escape DRY cross-svc.
 *
 * Pattern consolidado:
 * - W13 pass 31: notification-svc renderMustache _htmlEscape inline
 * - W7 pass 50: auth-svc /forgot-password body_html escape inline
 * - W7 pass 51: auth-svc /register welcome body_html escape inline
 *
 * 3 consumers com mesma logica duplicada = bug a quebrar 1 dos 3 = XSS
 * silent em produção. DRY consolidacao.
 *
 * USAGE:
 *   const { htmlEscape } = require('@cas/shared');
 *   const safe = htmlEscape(userInput);
 *   const body = `<p>Ola <b>${safe}</b></p>`;
 *
 * IMPORTANT:
 * - Escape caracteres: & < > " ' / (OWASP minimum recommended set)
 * - SO para context HTML body/attribute - NAO use em URL/JS/CSS context
 *   (cada context tem seu escape - JSON.stringify p/ JS, encodeURIComponent p/ URL)
 * - Input NULL/undefined retorna string vazia (defensive)
 * - Performance: ~1μs por call em strings tipicas (regex compilado uma vez)
 */
const HTML_ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '/': '&#x2F;',
};

const HTML_ESCAPE_RE = /[&<>"'/]/g;

function htmlEscape(s) {
  if (s == null) return '';
  return String(s).replace(HTML_ESCAPE_RE, (c) => HTML_ESCAPE_MAP[c]);
}

module.exports = { htmlEscape };
