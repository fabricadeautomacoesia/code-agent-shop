'use strict';

const express = require('express');
const { z } = require('zod');
const { query } = require('@cas/db-client');
const { jwt, asyncHandler, validate, errorHandler, cache } = require('@cas/shared');

const router = express.Router();
router.use(jwt.requireAuth());

// FIX-WORKER-7: regex de UUID para validar params antes do query (evita PG 22P02 -> 404 generico)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /products/wishlist - lista favoritos do user logado
// FIX-WORKER-7 pass 80: 7 BUGS aplicando Pattern W7 (Regras A+D+E + N+1 + filter + cache + UX).
//
// BUG 1 *** Regra A *** p.status = 'approved' exclui platform_owned
//   User favoritou produto MLB (platform_owned) -> some da lista wishlist.
//   FIX: status IN ('approved','platform_owned') (mesma classe pass 73-79).
//
// BUG 2 *** Regra D *** ORDER BY w.created_at DESC sem tiebreaker
//   User favoritou bulk script em segundos -> created_at identicos.
//   FIX: + w.product_id ASC tiebreaker.
//
// BUG 3 *** Regra E *** hardcoded LIMIT 200 sem ?limit/?offset
//   Heavy user 500+ favoritos -> só vê 200 primeiros.
//   FIX: ?limit (1-200, default 50) + ?offset + total + has_more.
//
// BUG 4 *** N+1 SUBQUERIES *** 4 subqueries correlacionadas por row
//   200 products * 4 subqueries = 800 sub-statements PG por hit.
//   FIX: LEFT JOIN sellers + categories explicit (1 plan node previsivel).
//
// BUG 5 *** ?kind FILTER MISSING *** UX triagem
//   User 200+ favoritos quer ver SO ai_agent / n8n_workflow.
//   FIX: ?kind enum whitelist (matches draftSchema).
//
// BUG 6 *** CACHE MISSING ***
//   /conta/favoritos hot path - user volta com frequencia.
//   Cache 30s per-user (alta freshness pois user pode add/remove).
//   FIX: cache.cacheMiddleware 30s vary by user+filtros.
//
// BUG 7 *** UX count -> total ***
//   PRE-FIX: response count = retornados (não total absoluto).
//   FIX: total = COUNT(*) absoluto, count = paginated rows.
const WISHLIST_KIND_ENUM = new Set([
  'automation','ai_agent','n8n_workflow','node_script','python_script',
  'php_script','prompt_pack','template','dataset','other'
]);

const wishlistCacheKey = (req) => {
  const lim = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
  const off = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const kind = req.query.kind || '';
  return `wishlist:${req.user?.sub || 'anon'}:lim=${lim}:off=${off}:k=${kind}`;
};

router.get('/',
  cache.cacheMiddleware(wishlistCacheKey, 30),
  asyncHandler(async (req, res) => {
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

    // BUG 5: kind enum whitelist
    const kindFilter = req.query.kind ? String(req.query.kind) : null;
    if (kindFilter && !WISHLIST_KIND_ENUM.has(kindFilter)) {
      return res.status(400).json({ error: 'invalid_kind', allowed: Array.from(WISHLIST_KIND_ENUM) });
    }

    // Build WHERE
    const whereParts = [
      'w.user_id = $1',
      `p.status IN ('approved','platform_owned')`,
      'p.deleted_at IS NULL',
    ];
    const params = [req.user.sub];
    let i = 2;
    if (kindFilter) {
      whereParts.push(`p.kind = $${i++}`);
      params.push(kindFilter);
    }
    params.push(limit, offset);
    const limIdx = i++;
    const offIdx = i++;

    // BUG 4: LEFT JOIN explicit (substitui 4 subqueries)
    // FIX-WORKER-18 pass 178: COUNT(*) OVER() window elimina segunda query
    // pelo COUNT total. PG executa scan unico - latencia ~30ms -> ~15ms.
    const r = await query(
      `SELECT p.id, p.slug, p.title, p.subtitle, p.short_description, p.kind,
              p.cover_image_url, p.price_cents, p.currency, p.is_free,
              p.avg_rating, p.review_count, p.sales_count, p.is_platform_owned,
              s.store_slug, s.store_name, s.reputation_tier,
              c.slug AS category_slug,
              w.created_at AS favorited_at,
              COUNT(*) OVER()::INT AS _total
         FROM product_wishlist w
         JOIN products p ON p.id = w.product_id
         LEFT JOIN sellers s ON s.id = p.seller_id
         LEFT JOIN categories c ON c.id = p.category_id
        WHERE ${whereParts.join(' AND ')}
        ORDER BY w.created_at DESC, w.product_id DESC
        LIMIT $${limIdx} OFFSET $${offIdx}`,
      params
    );

    const total = r.rows[0]?._total || 0;
    // Strip _total interno do response
    const products = r.rows.map((row) => {
      const { _total, ...rest } = row;
      return rest;
    });

    res.json({
      products,
      count: products.length,
      total, limit, offset,
      has_more: (offset + products.length) < total,
      kind: kindFilter,
    });
  })
);

// FIX-WORKER-18 pass 178: helper invalida cache wishlist do user.
// Chamado em POST/DELETE/check apos mutation.
// Pattern compativel com Redis cache.del wildcard (SCAN+DEL).
async function invalidateWishlistCache(userId) {
  try {
    await cache.del(`wishlist:${userId}:*`);
    // Tambem invalida check endpoint cache (futuro adiciona em /:product_id/check)
    await cache.del(`wishlist:check:${userId}:*`);
  } catch (_) { /* best-effort */ }
}

// POST /products/wishlist - adiciona aos favoritos
// FIX-WORKER-7: antes vazava FK violation 500 com nome de constraint Postgres ao cliente.
// Agora pre-valida existencia do produto -> 404 product_not_found (sem leak).
// FIX-WORKER-7 pass 80: Regra A no pre-check status whitelist completa.
//   PRE-FIX: status = 'approved' exclui platform_owned.
//   User clica favoritar em MLB product PDP -> 404 spurious "product_not_found".
//   FIX: status IN ('approved','platform_owned').
router.post('/',
  validate({ body: z.object({ product_id: z.string().uuid() }) }),
  asyncHandler(async (req, res, next) => {
    const exists = await query(
      `SELECT 1 FROM products
        WHERE id = $1 AND deleted_at IS NULL
          AND status IN ('approved','platform_owned')`,
      [req.body.product_id]
    );
    if (!exists.rows.length) return next(errorHandler.notFound('product_not_found'));
    /* FIX-WORKER-7 pass 290 (response distinguishability):
       PRE-FIX: ON CONFLICT DO NOTHING + res.json({ok:true}) sem feedback
       de added vs already-favoritado. Frontend WishlistButton mostra mesmo
       toast "Adicionado!" em ambos casos - UX confuso para user que clica
       2x rapido (debounce miss) e ve "Adicionado" sem mudanca de UI.
       POST-FIX: RETURNING + check rowcount. Response inclui already_exists:
       boolean - frontend pode mostrar "Ja estava favoritado" toast diferente
       OU skip animation se duplicate. Pattern V8 cross-svc REST clarity. */
    let r;
    try {
      r = await query(
        `INSERT INTO product_wishlist (user_id, product_id) VALUES ($1, $2)
         ON CONFLICT (user_id, product_id) DO NOTHING
         RETURNING product_id`,
        [req.user.sub, req.body.product_id]
      );
    } catch (e) {
      // defesa em profundidade caso outra constraint dispare (e.g. user deletado)
      if (e.code === '23503') return next(errorHandler.notFound('product_not_found'));
      throw e;
    }
    const alreadyExists = r.rows.length === 0;
    // Invalida cache so se realmente adicionou (otimizacao - duplicate noop)
    if (!alreadyExists) {
      // FIX-WORKER-18 pass 178: invalida cache GET /wishlist + check
      await invalidateWishlistCache(req.user.sub);
    }
    res.json({
      ok: true,
      already_exists: alreadyExists,
      product_id: req.body.product_id,
    });
  })
);

// DELETE /products/wishlist/:product_id
// FIX-WORKER-7:
// - Antes: UUID malformado -> PG 22P02 -> 404 generico do global handler (confuso)
// - Antes: UUID valido mas nao favoritado -> retornava {ok:true} silencioso (falha invisivel)
// - Agora: 400 invalid_uuid + 404 not_in_wishlist com RETURNING
router.delete('/:product_id', asyncHandler(async (req, res, next) => {
  if (!UUID_RE.test(req.params.product_id)) {
    return next(errorHandler.badRequest('invalid_uuid'));
  }
  const r = await query(
    `DELETE FROM product_wishlist WHERE user_id = $1 AND product_id = $2 RETURNING product_id`,
    [req.user.sub, req.params.product_id]
  );
  if (!r.rows.length) return next(errorHandler.notFound('not_in_wishlist'));
  // FIX-WORKER-18 pass 178: invalida cache GET /wishlist + check
  await invalidateWishlistCache(req.user.sub);
  res.json({ ok: true, removed: r.rows[0].product_id });
}));

// GET /products/wishlist/:product_id/check - retorna se esta favoritado
// FIX-WORKER-7: 400 invalid_uuid em vez de 404 generico do global handler
// FIX-WORKER-18 pass 178: cache 60s. Hot path - chamado de cada ProductCard
// + WishlistButton em PDP. 100 produtos visiveis = 100 hits ate now.
// Cache 60s + invalidation em POST/DELETE wishlist mantem freshness.
const checkCacheKey = (req) => `wishlist:check:${req.user?.sub || 'anon'}:${req.params.product_id}`;
router.get('/:product_id/check',
  cache.cacheMiddleware(checkCacheKey, 60),
  asyncHandler(async (req, res, next) => {
    if (!UUID_RE.test(req.params.product_id)) {
      return next(errorHandler.badRequest('invalid_uuid'));
    }
    const r = await query(
      `SELECT 1 FROM product_wishlist WHERE user_id = $1 AND product_id = $2`,
      [req.user.sub, req.params.product_id]
    );
    res.json({ favorited: r.rows.length > 0 });
  })
);

module.exports = router;
