'use strict';

/**
 * WORKER 7 pass 4: helper para clamp seguro de query params de paginacao.
 *
 * Bug recorrente em 8+ endpoints: Math.min(parseInt||default, max) deixava
 * negativos passarem -> SQL "LIMIT -5" -> PG ERROR mascarado como [] HTTP 200.
 *
 * Uso:
 *   const { lim, off } = parsePaginate(req.query, { default: 24, max: 60 });
 *   // lim sempre 1..60, off sempre >=0
 *
 * Garante invariant em TODOS os edge cases:
 * - undefined -> default
 * - "abc" (NaN) -> default
 * - "0" -> default (via OR)
 * - "-5" -> 1 (Math.max innermost)
 * - "99999" -> max (Math.min outer)
 * - page "0" -> 1 (Math.max innermost)
 * - page "-3" -> 1
 */
function parsePaginate(query, opts = {}) {
  const defaultLim = opts.default || 24;
  const maxLim = opts.max || 100;
  const lim = Math.max(1, Math.min(parseInt(query.limit, 10) || defaultLim, maxLim));
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const off = (page - 1) * lim;
  return { lim, off, page };
}

/**
 * Variante apenas com limit (sem paginacao por page/off).
 * Para endpoints "give me top N" sem cursor.
 */
function parseLimit(query, opts = {}) {
  const defaultLim = opts.default || 24;
  const maxLim = opts.max || 100;
  return Math.max(1, Math.min(parseInt(query.limit, 10) || defaultLim, maxLim));
}

module.exports = { parsePaginate, parseLimit };
