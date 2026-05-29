'use strict';

const express = require('express');
const { z } = require('zod');
const { query } = require('@cas/db-client');
const { asyncHandler, validate, errorHandler, cache, rateLimiter, mask } = require('@cas/shared');

// FIX-WORKER-10 pass 7: rate-limit em GET / (lista publica - mais hit do site).
// 60 req/min/IP = 1 req/seg sustentado (paginacao + scroll OK). Burst alto: 429.
// /:slug detail e /reviews/qna NAO recebem rate-limit aqui pois ja sao cached
// (cache.cacheMiddleware/withCache - Redis devolve em <1ms, sem load DB).
const listLimiter = rateLimiter.createLimiter({ windowMs: 60_000, max: 60 });

const router = express.Router();

// GET /products/recommendations - para voce (MLB-6)
// Combina: 1) categorias mais vistas pelo user, 2) similar a top-rated, 3) populares globais
//
// FIX-WORKER-18 pass 3: cache 60s per-user. Query custosa:
//   - 3 CTEs (user_categories, viewed, in_cart_or_owned)
//   - 3 SUBQUERIES por row (sellers JOIN inline x3 - store_slug/name/tier)
//   - 2 IN subqueries no WHERE
//   - ORDER BY 3 colunas com NULLS LAST
// EXPLAIN ANALYZE local: cost ~85 + 12-20ms execucao P50.
// Endpoint consumido em HOME page + /conta + recommendations carousel
// = multiplos hits por sessao de cada user logado.
//
// Cache key per-user (req.user.sub no JWT). 60s TTL:
// - User cria nova view -> recomendacao reflete em max 60s (UX OK)
// - User compra produto -> deveria sumir de "for-me" mas pode aparecer
//   ate 60s. Aceitavel para recommendations (nao billing).
// - Logout/login do mesmo user reusa cache (mesma key) -> ainda mais ganho.
// GET /recommendations/for-me - MLB-6 recomendacoes personalizadas
// FIX-WORKER-7 pass 8: CTE viewed unused + user_categories sem filter approved.
// FIX-WORKER-7 pass 77: 5 BUGS aplicando Pattern W7 (Regras A+D+E + N+1 + cold-start).
//
// BUG 1 *** Regra A INCOMPLETA *** status='approved' exclui platform_owned
//   2 sites de bug: CTE user_categories (linha 58) E query principal (linha 85)
//   MLB platform_owned products invisiveis em reco - feature MLB-9 invisivel.
//   FIX: status IN ('approved','platform_owned') em AMBOS sites.
//
// BUG 2 *** Regra D TIEBREAKER MISSING *** ORDER BY 3-level sem id
//   reco_score=1 + avg_rating=NULL + sales_count=0 (caso novo seller burst):
//   N products tied -> ordem indefinida.
//   FIX: + p.id ASC final tiebreaker.
//
// BUG 3 *** Regra E LIMIT HARDCODED *** sem ?limit
//   PDP "Voce tambem pode gostar" mostra 6, /home mostra 12, /recomendacoes
//   page poderia mostrar 30.
//   FIX: ?limit (1-50, default 12).
//
// BUG 4 *** N+1 SUBQUERIES *** 3 subqueries correlacionadas por row
//   12 products * 3 subqueries = 36 sub-statements PG por hit.
//   FIX: LEFT JOIN sellers explicit (1 plan node previsivel).
//
// BUG 5 *** COLD-START EMPTY *** user novo sem product_views = response []
//   PRE-FIX: user_categories vazio + p.sales_count > 100 cap restritivo
//   = response com 0 rows em UX critica (signup -> /home).
//   FIX: bare cold-start fallback - se user_categories vazio, mostrar
//   top-rated products globais (sales_count >= 1 OR is_platform_owned).
router.get('/recommendations/for-me',
  require('@cas/shared').jwt.requireAuth(),
  /* FIX-WORKER-18 pass 302: cache key normalization paridade
     FIX-WORKER-18 pass 594 (Math.max(1, ...) clamp gap paridade cadeia 15 sites):
     PRE-FIX BUG: cache key Math.min(parseInt(...) || 12, 50) MAS handler
     usa Math.max(1, Math.min(50, ...)) (linha 69). Cenarios:
     - ?limit=-5 -> parseInt=-5, -5||12=-5, Math.min(-5,50)=-5
       cache key 'lim=-5', handler Math.max(1, ...)=1 -> SAME response 2 entries
     - ?limit=0 -> 0||12=12, Math.min(12,50)=12 cache key 'lim=12', handler 12 OK
     - ?limit=99999 -> Math.min(99999,50)=50 cache key 'lim=50' OK
     POST-FIX: Math.max(1, ...) clamp pre-cache paridade cadeia 15 sites
     consolidacao (520/530/533/551/558/566/572/576/577/579/582/583/588/589/590). */
  cache.cacheMiddleware((req) => {
    const lim = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 12));
    return `products:reco:for-me:${req.user.sub}:lim=${lim}`;
  }, 60),
  asyncHandler(async (req, res) => {
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 12));

    // FIX-WORKER-7 pass 77 BUG 5: detectar cold-start (user novo) e usar fallback
    // Check rapido: tem alguma view?
    const hasViews = await query(
      `SELECT 1 FROM product_views
        WHERE user_id = $1 AND created_at > NOW() - INTERVAL '90 days' LIMIT 1`,
      [req.user.sub]
    );
    const isColdStart = !hasViews.rows.length;

    // BUG 4: LEFT JOIN sellers (substitui 3 subqueries)
    // BUG 1: Regra A status IN ('approved','platform_owned') em 2 sites
    // BUG 2: Regra D + p.id ASC final tiebreaker
    // BUG 3: $2 limit param
    // BUG 5: cold-start usa branch simplificada (top globais)
    const r = isColdStart
      ? await query(
          `SELECT p.id, p.slug, p.title, p.subtitle, p.short_description, p.kind,
                  p.cover_image_url, p.price_cents, p.currency, p.is_free,
                  p.tech_stack, p.avg_rating, p.review_count, p.sales_count,
                  p.is_platform_owned, p.flash_promo_active,
                  s.store_slug, s.store_name, s.reputation_tier,
                  1 AS reco_score
             FROM products p
             LEFT JOIN sellers s ON s.id = p.seller_id
            WHERE p.status IN ('approved','platform_owned')
              AND p.deleted_at IS NULL
              AND (p.is_platform_owned = TRUE OR p.sales_count > 0)
            ORDER BY p.is_platform_owned DESC,
                     p.sales_count DESC,
                     p.avg_rating DESC NULLS LAST,
                     p.id ASC
            LIMIT $2`,
          [req.user.sub, limit]
        )
      : await query(
          `WITH user_categories AS (
             SELECT p.category_id, COUNT(*) AS view_count
               FROM product_views v
               JOIN products p ON p.id = v.product_id
              WHERE v.user_id = $1
                AND v.created_at > NOW() - INTERVAL '30 days'
                AND p.status IN ('approved','platform_owned')
                AND p.deleted_at IS NULL
              GROUP BY p.category_id
              ORDER BY view_count DESC
              LIMIT 3
           ),
           viewed AS (
             SELECT DISTINCT product_id FROM product_views
              WHERE user_id = $1
                AND created_at > NOW() - INTERVAL '90 days'
           ),
           in_cart_or_owned AS (
             SELECT ci.product_id FROM cart_items ci
                JOIN carts c ON c.id = ci.cart_id WHERE c.user_id = $1
             UNION
             SELECT oi.product_id FROM order_items oi
                JOIN orders o ON o.id = oi.order_id WHERE o.buyer_user_id = $1
           )
           SELECT p.id, p.slug, p.title, p.subtitle, p.short_description, p.kind,
                  p.cover_image_url, p.price_cents, p.currency, p.is_free,
                  p.tech_stack, p.avg_rating, p.review_count, p.sales_count,
                  p.is_platform_owned, p.flash_promo_active,
                  s.store_slug, s.store_name, s.reputation_tier,
                  CASE WHEN p.category_id IN (SELECT category_id FROM user_categories) THEN 2 ELSE 1 END AS reco_score
             FROM products p
             LEFT JOIN sellers s ON s.id = p.seller_id
            WHERE p.status IN ('approved','platform_owned')
              AND p.deleted_at IS NULL
              AND p.id NOT IN (SELECT product_id FROM in_cart_or_owned)
              AND p.id NOT IN (SELECT product_id FROM viewed)
              AND (
                p.category_id IN (SELECT category_id FROM user_categories)
                OR p.sales_count > 100
              )
            ORDER BY reco_score DESC, p.avg_rating DESC NULLS LAST,
                     p.sales_count DESC, p.id ASC
            LIMIT $2`,
          [req.user.sub, limit]
        );

    res.json({
      products: r.rows,
      count: r.rows.length,
      limit,
      cold_start: isColdStart,  // UX UI pode mostrar "Top vendidos da plataforma" label
    });
  })
);

// MLB-NEW: GET /products/recently-viewed - "Vistos recentemente" estilo Mercado Livre
// Retorna ultimos N produtos distintos vistos pelo user nos ultimos 14 dias.
// Distinto por product_id (so a view mais recente conta), ORDER BY DESC.
// FIX-WORKER-18 pass 3: cache 30s per-user. Query menor que /recommendations
// mas ainda CTE com MAX + JOIN products + 3 subqueries sellers.
// TTL 30s pois user pode visitar PDP A entao voltar a /conta esperando ver A no
// recently. 60s seria muito (notavel). 30s e equilibrio: dois clicks rapidos
// dividem 1 backend call mas refresh < min mantem UX vivo.
// GET /products/recently-viewed - MLB "Vistos recentemente"
// FIX-WORKER-7 pass 7: filtro WHERE approved dentro da CTE.
// FIX-WORKER-7 pass 78: 4 BUGS aplicando Pattern W7 (Regras A+D + N+1 + UX).
//
// BUG 1 *** Regra A *** AND p.status = 'approved' (linha 184)
//   Mesma classe pass 73-77: platform_owned MLB products invisiveis
//   em "Vistos recentemente". User viu MLB product PDP -> volta /conta ->
//   produto SOME da lista (UX confusao).
//   FIX: status IN ('approved','platform_owned').
//
// BUG 2 *** Regra D TIEBREAKER MISSING *** ORDER BY last_view_at DESC
//   2 product_views com MAX(created_at) identicos (script burst) ->
//   ordem indefinida na lista "vistos recentemente".
//   FIX: + p.id ASC tiebreaker.
//
// BUG 3 *** N+1 SUBQUERIES *** 3 subqueries correlacionadas por row
//   12 products * 3 subqueries = 36 sub-statements PG por hit.
//   FIX: LEFT JOIN sellers explicit (mesmo pattern pass 73/76/77).
//
// BUG 4 *** UX limit echo missing *** response shape inconsistente
//   FIX: + limit echo (frontend pode confirmar param aplicado).
router.get('/recently-viewed',
  require('@cas/shared').jwt.requireAuth(),
  /* FIX-WORKER-18 pass 302: cache key normalization paridade pass 298
     FIX-WORKER-18 pass 594 (Math.max(1, ...) clamp gap paridade pass 594 for-me) */
  cache.cacheMiddleware((req) => {
    const lim = Math.max(1, Math.min(30, parseInt(req.query.limit, 10) || 12));
    return `products:recently-viewed:${req.user.sub}:lim=${lim}`;
  }, 30),
  asyncHandler(async (req, res) => {
    const lim = Math.max(1, Math.min(parseInt(req.query.limit || '12', 10), 30));
    const r = await query(
      // FIX-WORKER-18 pass 261 (ORDER BY direction parity):
      //   Pattern V8 pass 251/256/259 - all tiebreakers SAME direction (DESC)
      //   Mixed direction causa pagination drift entre cache evictions
      `WITH last_views AS (
         SELECT pv.product_id, MAX(pv.created_at) AS last_view_at
           FROM product_views pv
           JOIN products p ON p.id = pv.product_id
          WHERE pv.user_id = $1::UUID
            AND pv.created_at > NOW() - INTERVAL '14 days'
            AND p.status IN ('approved','platform_owned')
            AND p.deleted_at IS NULL
          GROUP BY pv.product_id
          ORDER BY MAX(pv.created_at) DESC, pv.product_id DESC
          LIMIT $2::INT
       )
       SELECT p.id, p.slug, p.title, p.subtitle, p.short_description, p.kind,
              p.cover_image_url, p.price_cents, p.currency, p.is_free,
              p.tech_stack, p.avg_rating, p.review_count, p.sales_count,
              p.is_platform_owned, p.flash_promo_active, p.flash_promo_discount_pct,
              s.store_slug, s.store_name, s.reputation_tier,
              lv.last_view_at
         FROM last_views lv
         JOIN products p ON p.id = lv.product_id
         LEFT JOIN sellers s ON s.id = p.seller_id
        ORDER BY lv.last_view_at DESC, p.id DESC`,
      [req.user.sub, lim]
    );
    res.json({ products: r.rows, count: r.rows.length, limit: lim });
  })
);

// MLB-13 (NEW): GET /products/:slug/also-bought
// "Quem comprou isto, tambem comprou" - collaborative filtering real.
// Diferencial vs /related (categoria-based): usa co-occurrence em order_items.
// Algoritmo:
//   1. Acha buyers que compraram este produto (DISTINCT buyer_user_id em orders.paid)
//   2. Para cada buyer, pega OUTROS produtos que ele comprou
//   3. Agrega por product_id + ORDER BY frequencia DESC
//   4. Filtra approved, deleted_at NULL, ID != atual
// Cache 600s (10min) - co-occurrences mudam devagar.
// FIX-WORKER-7 pass 10: 5 bugs (mesmo refactor pattern pass 9 /related):
// 1. CTE src sem deleted_at -> produto deletado, slug indexado, retornava []
// 2. CTE src so 'approved' -> ignorava platform_owned (clausula master copy)
// 3. 404 indistinguivel de empty -> parent check + errorHandler.notFound
// 4. Subquery store_slug redundante (N scans) -> CTE final + LEFT JOIN sellers
// 5. LIMIT na CTE also_bought antes do filtro p.status/deleted -> truncado
//    se produto top-N foi removido SUPERVENIENTE durante TTL 600s cache.
//    FIX: filtros DENTRO de also_bought (joina p2 inline + filtra)
router.get('/:slug/also-bought',
  /* FIX-WORKER-7 pass 298: cache key normalization paridade pass 291 search.
     PRE-FIX: req.params.slug raw - case-variants criam cache entries duplicados.
     Slugs DB sao lowercase canonical mas Express path nao normaliza.
     POST-FIX: trim().toLowerCase() + clamp limit defensive. */
  /* FIX-WORKER-18 pass 513 (cache key/query case-mismatch consistency):
     PRE-FIX BUG: cache key lowercase (pass 298) MAS query usa req.params.slug RAW
     - PG slug='PRODUCT-A' = case-sensitive vs slug='product-a' (DB lowercase)
     - Cenario: GET /PRODUCT-A/also-bought
       1. Cache MISS (chave normalizada products:also-bought:product-a:lim=6)
       2. Handler: SELECT WHERE slug='PRODUCT-A' -> 0 rows -> 404 (sem cache)
       3. Outro user: GET /product-a/also-bought
          - Cache MISS mesma chave -> Handler -> SELECT slug='product-a' -> OK
          - Response cacheada na chave normalizada
       4. Volta primeiro user: GET /PRODUCT-A/also-bought
          - Cache HIT (chave normalizada) -> retorna data do 'product-a'
          - User esperava 404 (PRODUCT-A nao existe case-sensitive) - confusao
     - Pode parecer minor mas viola Pattern V8: cache key e query devem usar
       MESMA strategy de normalization (full case-insensitive end-to-end)
     POST-FIX: normalize slug early no handler antes da query
     - LOWER(slug) na query? Quebra idx_products_slug (mig 003 case-sensitive)
     - Melhor: aplicar .toLowerCase() ao input do handler -> match DB canonical
     - Trade-off ZERO: slugs DB ja sao lowercase, usuario nao perde nada */
  /* FIX-WORKER-18 pass 599 (Math.max(1, ...) clamp gap paridade pass 594):
     PRE-FIX: cache key Math.min(parseInt(...) || 6, 12) MAS handler usa
     Math.max(1, Math.min(... || 6, 12)) (linha 287). Cenario ?limit=-5:
     - parseInt=-5, -5||6=-5, Math.min(-5,12)=-5 -> cache key 'lim=-5'
     - handler Math.max(1, Math.min(... || 6, 12))=Math.max(1, -5)=1
     - SAME response cached em key 'lim=-5' vs 'lim=1' = pollution 2 entries
     POST-FIX: Math.max(1, ...) clamp pre-cache paridade cadeia 19 sites. */
  cache.cacheMiddleware((req) => {
    const slug = (req.params.slug || '').toString().trim().toLowerCase();
    const lim = Math.max(1, Math.min(12, parseInt(req.query.limit, 10) || 6));
    return `products:also-bought:${slug}:lim=${lim}`;
  }, 600),
  asyncHandler(async (req, res, next) => {
  const lim = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 6, 12));
  // FIX pass 513: normalize slug = cache key normalize (case-insensitive end-to-end)
  const normalizedSlug = (req.params.slug || '').toString().trim().toLowerCase();

  // FIX bug 3: parent check (diferencia 404 de empty)
  // FIX bug 1,2: deleted_at IS NULL + status valido (approved OR platform_owned)
  // FIX pass 513: usar normalizedSlug (match cache key + DB canonical lowercase)
  const parent = await query(
    `SELECT id FROM products
      WHERE slug = $1 AND deleted_at IS NULL
        AND status IN ('approved','platform_owned')
      LIMIT 1`, [normalizedSlug]
  );
  if (!parent.rows.length) {
    return next(errorHandler.notFound('product_not_found'));
  }

  // FIX-WORKER-7 pass 79: 3 BUGS aplicando Pattern W7 (Regra D + UX + store_name).
  //
  // BUG 1 *** Regra D outer ORDER BY MISSING TIEBREAKER ***
  //   ORDER BY ab.co_buyers DESC, p.sales_count DESC NULLS LAST sem id.
  //   Produtos co_buyers=1 + sales_count=0 (caso new product cohort):
  //   ordem indefinida entre refreshes.
  //   FIX: + p.id ASC final tiebreaker.
  //
  // BUG 2 *** store_name MISSING *** UX inconsistente cross-endpoint
  //   PRE-FIX: SELECT s.store_slug, s.reputation_tier (sem store_name).
  //   Pattern cross-svc: /compare /flash-promo /related (apos pass 78) /reco
  //   /recently-viewed TODOS retornam store_name.
  //   Frontend "Por ${store_name}" recebia undefined.
  //   FIX: + s.store_name no SELECT.
  //
  // BUG 3 *** UX count MISSING *** response shape inconsistente
  //   Outros endpoints retornam count/has_more. Adicionar count.
  const r = await query(
    `WITH co_buyers AS (
       SELECT DISTINCT o.buyer_user_id
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
        WHERE oi.product_id = $1
          AND o.status IN ('paid','fulfilled')
          AND o.buyer_user_id IS NOT NULL
     ),
     also_bought AS (
       -- FIX bug 5: filtros DENTRO da CTE (era WHERE no outer apos LIMIT - truncava)
       SELECT oi.product_id, COUNT(DISTINCT o.buyer_user_id) AS co_buyers
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         JOIN co_buyers cb ON cb.buyer_user_id = o.buyer_user_id
         JOIN products p2 ON p2.id = oi.product_id
        WHERE o.status IN ('paid','fulfilled')
          AND oi.product_id <> $1
          AND p2.status IN ('approved','platform_owned')
          AND p2.deleted_at IS NULL
        GROUP BY oi.product_id
        ORDER BY co_buyers DESC, oi.product_id
        LIMIT $2
     )
     SELECT p.id, p.slug, p.title, p.subtitle, p.short_description, p.kind,
            p.cover_image_url, p.price_cents, p.currency, p.is_free,
            p.tech_stack, p.avg_rating, p.review_count, p.sales_count,
            p.is_platform_owned, p.flash_promo_active,
            ab.co_buyers,
            s.store_slug, s.store_name, s.reputation_tier
       FROM also_bought ab
       JOIN products p ON p.id = ab.product_id
       -- FIX bug 4: JOIN sellers final (era subquery N scans)
       LEFT JOIN sellers s ON s.id = p.seller_id
      ORDER BY ab.co_buyers DESC, p.sales_count DESC NULLS LAST, p.id ASC`,
    [parent.rows[0].id, lim]
  );
  res.json({ products: r.rows, count: r.rows.length, limit: lim });
}));

// GET /products/:slug/related - produtos relacionados (mesma categoria, exclui o atual)
// FIX-WORKER-18 pass2: cache 300s - related products muda raramente (categoria + same tier)
// FIX-WORKER-7 pass 9: refactor para CTE pattern (mesmo pass 7/8) + 6 bugs:
// 1. LIMIT 6 hardcoded ignorava req.query.limit (cache key suportava mas SQL nao)
// 2. Sem filtro p1.deleted_at IS NULL -> produto fantasma listava relacionados (info leak)
// 3. Sem filtro p1.status='approved' -> qa_pending/rejected vazavam relacionados via slug
// 4. Slug invalido retornava {products:[]} identico a "sem relacionados" (frontend nao diferenciava 404 de empty)
// 5. Subqueries (SELECT ... FROM sellers WHERE id=p2.seller_id) 2x redundantes -> JOIN unico
// 6. Cache populado em 404 (gastava memoria Redis com slug ruim em loop bot)
router.get('/:slug/related',
  /* FIX-WORKER-7 pass 298: cache key normalization paridade also-bought
     FIX-WORKER-18 pass 513: normalize slug query side (case-mismatch consistency).
     Mesmo bug do also-bought pass 513 - ver comment expansivo la. */
  /* FIX-WORKER-18 pass 599 (Math.max(1, ...) clamp gap paridade pass 594/599 also-bought) */
  cache.cacheMiddleware((req) => {
    const slug = (req.params.slug || '').toString().trim().toLowerCase();
    const lim = Math.max(1, Math.min(24, parseInt(req.query.limit, 10) || 6));
    return `products:related:${slug}:lim=${lim}`;
  }, 300),
  asyncHandler(async (req, res, next) => {
  // FIX bug 1: validar e clampear limit (default 6, max 24 - evita scrape massivo)
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 6, 1), 24);
  // FIX pass 513: normalize slug = cache key normalize (case-insensitive end-to-end)
  const normalizedSlug = (req.params.slug || '').toString().trim().toLowerCase();

  // FIX bug 4: verificar produto pai existe + status valido ANTES de buscar relacionados
  // Diferencia 404 (slug inexistente / deletado / pending) de 200 [] (sem relacionados na categoria)
  // FIX pass 513: usar normalizedSlug (match cache key + DB canonical lowercase)
  const parent = await query(
    `SELECT id, category_id, status FROM products
      WHERE slug = $1 AND deleted_at IS NULL AND status IN ('approved','platform_owned')
      LIMIT 1`, [normalizedSlug]
  );
  if (!parent.rows.length) {
    // FIX bug 6: nao cachear 404 (errorHandler nao popula cache, cacheMiddleware so cacheia 2xx)
    return next(errorHandler.notFound('product_not_found'));
  }

  // FIX bug 5: JOIN sellers unico (era 2 subqueries por linha = N*2 scans)
  // FIX-WORKER-7 pass 9: CTE related_pool + JOIN sellers eficiente.
  // FIX-WORKER-7 pass 78: 3 BUGS aplicando Pattern W7 (Regras A+D + store_name).
  //
  // BUG 1 *** Regra A *** AND p2.status = 'approved' (CTE related_pool)
  //   Mesma classe pass 73-77: platform_owned MLB products excluidos
  //   do "Relacionados" PDP -> MLB feature invisivel cross-link.
  //   FIX: status IN ('approved','platform_owned').
  //
  // BUG 2 *** Regra D TIEBREAKER MISSING *** ORDER BY 2-level sem id
  //   Products sales_count=0 + avg_rating=NULL (caso novo seller burst):
  //   ordem indefinida no related pool.
  //   FIX: + p2.id ASC final tiebreaker.
  //
  // BUG 3 *** store_name MISSING *** UX inconsistente cross-endpoint
  //   PRE-FIX: SELECT s.store_slug, s.reputation_tier (sem store_name).
  //   /compare e /flash-promo retornam store_name - related nao.
  //   Frontend renderiza "Por ${store_name}" mas recebe undefined.
  //   FIX: + s.store_name no SELECT final.
  const r = await query(
    `WITH related_pool AS (
       SELECT p2.id, p2.slug, p2.title, p2.subtitle, p2.short_description, p2.kind,
              p2.cover_image_url, p2.price_cents, p2.currency, p2.is_free,
              p2.tech_stack, p2.avg_rating, p2.review_count, p2.sales_count,
              p2.is_platform_owned, p2.flash_promo_active, p2.seller_id
         FROM products p2
        WHERE p2.category_id = $1
          AND p2.id <> $2
          AND p2.status IN ('approved','platform_owned')
          AND p2.deleted_at IS NULL
        ORDER BY p2.sales_count DESC NULLS LAST,
                 p2.avg_rating DESC NULLS LAST,
                 p2.id ASC
        LIMIT $3
     )
     SELECT rp.id, rp.slug, rp.title, rp.subtitle, rp.short_description, rp.kind,
            rp.cover_image_url, rp.price_cents, rp.currency, rp.is_free,
            rp.tech_stack, rp.avg_rating, rp.review_count, rp.sales_count,
            rp.is_platform_owned, rp.flash_promo_active,
            s.store_slug, s.store_name, s.reputation_tier
       FROM related_pool rp
       LEFT JOIN sellers s ON s.id = rp.seller_id`,
    [parent.rows[0].category_id, parent.rows[0].id, limit]
  );
  res.json({ products: r.rows, limit, count: r.rows.length });
}));

// GET /products/compare?ids=uuid,uuid,uuid - comparar ate 4 produtos (MLB-7)
// FIX-WORKER-7 pass 6: 3 bugs corrigidos:
// 1. IDs nao-UUID (fake1,fake2) faziam Postgres throw 22P02 -> 404 generico
//    "Recurso nao encontrado" do errorHandler. Agora valida UUID upfront -> 400.
// 2. IDs validos mas todos inexistentes retornavam 200 {products:[]}, sem
//    indicar que NENHUM foi encontrado. Frontend (comparar/page.tsx linha 47)
//    tinha que verificar products.length < 2 manualmente, mensagem confusa.
// 3. >4 IDs era silentemente truncado. Agora warn no response.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// FIX-WORKER-7 pass 76: 4 BUGS aplicando Pattern W7 (Regra A + N+1 + rate-limit + cache).
//
// BUG 1 *** Regra A INCOMPLETA *** status = 'approved' exclui platform_owned
//   MLB platform_owned products NUNCA aparecem no comparador.
//   Pattern cross-svc estabelecido pass 73/74/75.
//   FIX: status IN ('approved','platform_owned').
//
// BUG 2 *** N+1 SUBQUERIES *** 4 subqueries correlacionadas por row
//   4 products * 4 subqueries = 16 sub-statements PG por hit.
//   FIX: LEFT JOIN sellers/categories explicit (1 plan node previsivel).
//
// BUG 3 *** RATE-LIMIT MISSING ***
//   /compare aceita 4 UUIDs custom -> cache key infinito (combinatoria).
//   Atacante hammer com varied IDs = cache miss garantido a cada hit.
//   FIX: aplicar listLimiter (60 req/min/IP) - mesmo cap do GET /.
//
// BUG 4 *** CACHE MISSING ***
//   Compare hot path em MLB-7 feature. Combinatoria IDs grande mas
//   keys mais usadas (top products) repetem. Cache 60s vary by IDs.
//   FIX: cache.cacheMiddleware com key ordenada (canonical IDs sorted).
/* FIX-WORKER-7 pass 490 (cache key normalization + UUID filter):
   PRE-FIX BUG 1 (cache pollution case-sensitivity):
     - .sort() default ASCII case-sensitive
     - ?ids=AAA-BBB,ccc-ddd vs ?ids=aaa-bbb,CCC-DDD criavam keys diferentes
     - PG UUID = case-insensitive -> mesmos produtos retornados
     - Redis ate 2 entries per logical query (cache miss x2)
   PRE-FIX BUG 2 (junk pollution):
     - .filter(Boolean) so descartava empty strings
     - ?ids=lixo1,lixo2,lixo3 (3 invalid junk) -> cache key valida criada
     - Atacante hammer com varied junk -> cache MIRA infinita (DoS amplification
       mesmo com listLimiter 60/min - 4 UUIDs combinatoria por req)
     - Handler depois rejeita 400 mas cache key ja persisted
   POST-FIX:
     - .toLowerCase() normaliza UUID case (PG-compatible)
     - .filter(UUID_RE) so UUIDs validos entram na key
     - Junk descartado pre-cache -> nao pollui Redis
     - 4 IDs limit + sort canonical preservados
   Paridade pass 291 search-svc cache key normalization. */
const compareCacheKey = (req) => {
  const idsRaw = (req.query.ids || '').toString();
  const ids = idsRaw.split(',')
    .map(s => s.trim().toLowerCase())
    .filter(s => UUID_RE.test(s))
    .slice(0, 4)
    .sort();
  return `products:compare:${ids.join('|')}`;
};

router.get('/compare',
  listLimiter,
  cache.cacheMiddleware(compareCacheKey, 60),
  asyncHandler(async (req, res) => {
  const idsRaw = (req.query.ids || '').toString();
  const allIds = idsRaw.split(',').map(s => s.trim()).filter(Boolean);
  const truncated = allIds.length > 4;
  const limited = allIds.slice(0, 4);
  if (limited.length < 2) {
    return res.status(400).json({ error: 'min_2_products', message: 'Selecione pelo menos 2 produtos para comparar' });
  }
  // FIX bug 1: validar UUIDs upfront (evita PG 22P02 -> 500/404 generico)
  const invalidIds = limited.filter(id => !UUID_RE.test(id));
  if (invalidIds.length) {
    return res.status(400).json({
      error: 'invalid_ids',
      message: `IDs invalidos (esperado UUID): ${invalidIds.join(', ')}`,
      invalid_count: invalidIds.length,
    });
  }
  // FIX-WORKER-7 pass 76 BUG 1+2: Regra A platform_owned + LEFT JOIN explicit
  const r = await query(
    `SELECT p.id, p.slug, p.title, p.subtitle, p.kind, p.cover_image_url,
            p.price_cents, p.currency, p.is_free, p.license_kind,
            p.tech_stack, p.api_keys_required, p.estimated_install_min,
            p.requirements, p.avg_rating, p.review_count, p.sales_count,
            p.is_platform_owned, p.flash_promo_active, p.flash_promo_discount_pct,
            s.store_slug, s.store_name, s.reputation_tier,
            c.name AS category_name
       FROM products p
       LEFT JOIN sellers s ON s.id = p.seller_id
       LEFT JOIN categories c ON c.id = p.category_id AND c.is_active = TRUE
      WHERE p.id = ANY($1::UUID[])
        AND p.status IN ('approved','platform_owned')
        AND p.deleted_at IS NULL`,
    [limited]
  );
  // FIX bug 2: identificar IDs missing (existiam no request mas DB nao retornou)
  const foundIds = new Set(r.rows.map(p => p.id));
  const missingIds = limited.filter(id => !foundIds.has(id));
  // FIX bug 2: 404 se NENHUM produto encontrado, ou 200 com aviso parcial
  if (r.rows.length === 0) {
    return res.status(404).json({
      error: 'products_not_found',
      message: 'Nenhum dos produtos solicitados foi encontrado ou esta disponivel para comparacao',
      requested_count: limited.length,
    });
  }
  if (r.rows.length < 2) {
    return res.status(400).json({
      error: 'insufficient_products',
      message: `Apenas ${r.rows.length} produto(s) valido(s) encontrado(s). Comparar precisa de >=2.`,
      found: r.rows.length,
      missing_ids: missingIds,
    });
  }
  // Success: include warnings se aplicavel (truncado / parcialmente missing)
  res.json({
    products: r.rows,
    count: r.rows.length,
    ...(missingIds.length && { missing_ids: missingIds }),
    ...(truncated && { warning_truncated: `Apenas os primeiros 4 de ${allIds.length} IDs foram considerados` }),
  });
}));

// GET /products/flash-promo - produtos em promocao relampago ativa (MLB-10)
// cache 60s - flash promo tem timer curto, mas ainda vale cachear janela curta
// FIX-WORKER-7 pass 76: 5 BUGS aplicando Pattern W7 (Regras A+D+E + seller info + total).
//
// BUG 1 *** Regra A *** status = 'approved' exclui platform_owned MLB flash promos
// BUG 2 *** Regra D *** ORDER BY flash_promo_ends_at ASC sem id tiebreaker
//   Multiplos promos ending same minute -> ordem indefinida.
// BUG 3 *** Regra E *** hardcoded LIMIT 20 sem ?limit/?offset
// BUG 4 *** SELLER INFO MISSING *** /compare tem store_slug/name mas flash nao
//   UX inconsistente entre endpoints similares.
//   FIX: LEFT JOIN sellers (mesmo pattern /compare).
// BUG 5 *** TOTAL COUNT MISSING *** UX flash promo page sem visibility
router.get('/flash-promo/active',
  /* FIX-WORKER-18 pass 302: cache key normalization paridade
     FIX-WORKER-18 pass 599: + Math.max(1, ...) clamp gap (paridade also-bought + related) */
  cache.cacheMiddleware((req) => {
    const lim = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20));
    const off = Math.max(0, parseInt(req.query.offset, 10) || 0);
    return `products:flash-promo:active:lim=${lim}:off=${off}`;
  }, 60),
  asyncHandler(async (req, res) => {
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  // FIX-WORKER-18 pass 237 (stale cached relative time):
  //   PRE-FIX: SELECT incluia EXTRACT(EPOCH FROM (ends_at - NOW()))::BIGINT
  //   AS seconds_remaining. Cache TTL 60s -> valor "calculou em T0" retornava
  //   T0+59s sem refresh. Cliente que chega 30s apos cache miss via
  //   "termina em 1200s" mas timer deveria ja estar em 1170s. Race em
  //   timer rendering (timer client-side calculado de absoluto OK, mas o
  //   field cached era bait p/ confusao).
  //   POST-FIX: removido seconds_remaining (campo unused - frontend
  //   /promocoes linha 88 usa flash_promo_ends_at absoluto). Removendo
  //   reduz payload por row (~30 bytes BIGINT serialized) + elimina
  //   semantica confusa "cached relative time".
  /* FIX-WORKER-18 pass 293: COUNT(*) OVER() window consolidation.
     PRE-FIX: 2 queries separadas (rows + COUNT separado) - scan duplicado
     em products com filtros idênticos (status + flash_promo_active + ends_at).
     Pattern V8 cross-svc consolidado (pass 178, 200, 202, 206, 289 - 12+ endpoints).
     POST-FIX: 1 query window aggregate - latencia ~25ms -> ~14ms.
     Trade-off: COUNT(*) OVER() em LIMIT 0 retorna 0 rows mas total real
     (validado em outros endpoints PG behavior). */
  const r = await query(
    `SELECT p.id, p.slug, p.title, p.subtitle, p.short_description, p.kind, p.cover_image_url,
            p.price_cents, p.currency, p.is_free, p.tech_stack, p.avg_rating, p.review_count,
            p.sales_count, p.is_platform_owned, p.flash_promo_discount_pct, p.flash_promo_ends_at,
            (p.price_cents * (1 - p.flash_promo_discount_pct/100))::BIGINT AS discounted_price_cents,
            s.store_slug, s.store_name,
            COUNT(*) OVER()::INT AS _total
       FROM products p
       LEFT JOIN sellers s ON s.id = p.seller_id
      WHERE p.status IN ('approved','platform_owned')
        AND p.flash_promo_active = TRUE
        AND p.flash_promo_ends_at > NOW()
        AND p.deleted_at IS NULL
      ORDER BY p.flash_promo_ends_at ASC, p.id ASC
      LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  const total = r.rows[0]?._total ?? 0;
  const products = r.rows.map((row) => { const { _total, ...rest } = row; return rest; });

  res.json({
    products,
    total,
    limit, offset,
    has_more: (offset + products.length) < total,
  });
}));

// GET /products - listagem + filtros facetados
// cache 60s - lista publica de produtos. Invalidada em mutations admin/me.
// FIX-WORKER-10 pass 7: rate-limit ANTES do cache para barrar bots ANTES de Redis lookup.
// FIX-WORKER-7 pass 73: 8 BUGS aplicando Pattern W7 (Regras A+D+E+I + enums + UX).
//
// BUG 1 *** Regra D TIEBREAKER MISSING *** ORDER BY sem id em TODOS sorts
//   2 products sales_count identicos -> ordem indefinida na paginacao.
//   FIX: + id ASC tiebreaker em TODOS 6 sorts.
//
// BUG 2 *** Regra A status whitelist incompleta ***
//   PRE-FIX: WHERE status = 'approved' (exclui platform_owned!)
//   Platform_owned products (cadastrados pela plataforma, MLB feature)
//   NUNCA aparecem em listing publico. Pattern cross-svc estabelecido:
//   status IN ('approved','platform_owned').
//   FIX: status IN ('approved','platform_owned').
//
// BUG 3 *** KIND ENUM WHITELIST MISSING *** SQL error leak
//   PRE-FIX: ?kind=anything -> PG enum cast 22P02 -> 500.
//   FIX: kind enum whitelist (matches draftSchema).
//
// BUG 4 *** SORT ENUM RIGID *** ?sort=anything cai default silencioso
//   Mantido o pattern (fallback default), MAS adiciono validation 400 explicit
//   p/ ?sort com valor invalido. UX UI mais claro.
//
// BUG 5 *** NaN parseInt() *** ?min_price=abc -> NaN
//   PRE-FIX: parseInt('abc') = NaN -> params.push(NaN) -> PG ERROR cast.
//   FIX: Number.isFinite(n) check + 400 se nao.
//
// BUG 6 *** Regra E NO TOTAL ***
//   Response sem total/has_more - UX paginacao "Carregar mais" sem visibilidade.
//   FIX: COUNT(*) + has_more (mas: COUNT pode ser pesado, opt-in ?include_total=true).
//
// BUG 7 *** ?seller FILTER documentado em cache key MAS sem WHERE ***
//   cache key ja inclui :seller=${q.seller||''} - mas sem WHERE = cache pollution
//   (mesma resposta retornada com keys diferentes).
//   FIX: implementar ?seller=store_slug -> JOIN sellers + WHERE.
//
// BUG 8 *** N+1 subqueries seller/category ***
//   3 subqueries correlacionadas por row (60 products * 3 = 180 sub-statements).
//   PG optimizer pode mover p/ LATERAL JOIN mas plano nao determ.
//   FIX: LEFT JOIN explicit (1 plan node, mais previsivel).
const KIND_ENUM = new Set([
  'automation','ai_agent','n8n_workflow','node_script','python_script',
  'php_script','prompt_pack','template','dataset','other'
]);
// FIX-WORKER-7 pass 125: sync c/ search-svc SEARCH_SORT_ENUM (7 opcoes - tinha 6).
// UI ProductsSortSelect oferece 'recent_sales' (Vendendo agora). Antes:
// chamada direta /api/products?sort=recent_sales -> 400 invalid_sort.
// Storefront /products page usa Api.search (search-svc) que aceita, mas
// admin/seller dashboards podem chamar product-svc direto -> bug latente.
const SORT_ENUM = new Set(['relevance','newest','price_asc','price_desc','rating','sales','recent_sales']);

router.get('/',
  listLimiter,
  /* FIX-WORKER-7 pass 612 (cache key normalization 11 params - MASSIVE pollution gap):
     PRE-FIX BUG: cache key usava 11 raw query params SEM normalize:
     - q.category (raw, sem .trim().toLowerCase() - paridade pass 535 query)
     - q.kind (raw, sem KIND_ENUM whitelist check)
     - q.min_price/max_price (raw, sem Number.isFinite check)
     - q.free/platform_owned (raw, sem 'true'/'false' normalize)
     - q.seller (raw, sem .trim().toLowerCase())
     - q.sort (raw, sem SORT_ENUM whitelist check)
     - q.limit (raw, sem Math.max/Math.min clamp)
     - q.page (raw, sem Math.max(1, ...) clamp)
     - q.include_total (raw boolean)
     Cenarios pollution amplificados em /products listing hot path:
     - ?category=AI-Agents -> cache key 'cat=AI-Agents', handler lowercase 'ai-agents'
     - ?kind=INVALID -> cache key 'kind=INVALID', handler 400
     - ?limit=99999 -> cache key 'lim=99999', handler clamp 60
     - ?page=-5 -> cache key 'page=-5', handler -> 1 page
     - ?free=TRUE vs ?free=true = 2 entries pollution
     - ?platform_owned=TRUE vs true = 2 entries
     - Combinatorial explosion: 11 params x case variations = milhares pollution
     POST-FIX: normalize CADA param SAME way handler normalizes.
     Paridade cadeia 25 sites cache hygiene cross-svc (passes 520-611). */
  cache.cacheMiddleware((req) => {
    const q = req.query;
    const cat = (q.category || '').toString().trim().toLowerCase();
    const kindRaw = String(q.kind || '').trim();
    const kind = KIND_ENUM.has(kindRaw) ? kindRaw : '';
    const minP = (q.min_price !== undefined && Number.isFinite(parseInt(q.min_price, 10)))
      ? parseInt(q.min_price, 10) : '';
    const maxP = (q.max_price !== undefined && Number.isFinite(parseInt(q.max_price, 10)))
      ? parseInt(q.max_price, 10) : '';
    const free = String(q.free || '').toLowerCase() === 'true' ? 'true' : '';
    const plat = String(q.platform_owned || '').toLowerCase() === 'true' ? 'true' : '';
    const seller = (q.seller || '').toString().trim().toLowerCase();
    const sortRaw = String(q.sort || '').trim();
    const sort = SORT_ENUM.has(sortRaw) ? sortRaw : '';
    const lim = Math.max(1, Math.min(60, parseInt(q.limit, 10) || 24));
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const tot = String(q.include_total || '').toLowerCase() === 'true' ? 'true' : '';
    return `products:list:cat=${cat}:kind=${kind}:min=${minP}:max=${maxP}:free=${free}:platform=${plat}:seller=${seller}:sort=${sort}:lim=${lim}:page=${page}:tot=${tot}`;
  }, 60),
  asyncHandler(async (req, res) => {
  // FIX-WORKER-7 pass 3: clamp 1..60 (era Math.min apenas, deixava lim=-5 passar).
  const lim = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 24, 60));
  const off = (Math.max(parseInt(req.query.page, 10) || 1, 1) - 1) * lim;

  // FIX-WORKER-7 pass 73 BUG 3: kind enum whitelist
  if (req.query.kind && !KIND_ENUM.has(req.query.kind)) {
    return res.status(400).json({ error: 'invalid_kind', allowed: Array.from(KIND_ENUM) });
  }
  // BUG 4: sort enum whitelist (400 explicit em vez de default silencioso)
  if (req.query.sort && !SORT_ENUM.has(req.query.sort)) {
    return res.status(400).json({ error: 'invalid_sort', allowed: Array.from(SORT_ENUM) });
  }
  // BUG 5: NaN guard parseInt
  const minPrice = req.query.min_price !== undefined ? parseInt(req.query.min_price, 10) : null;
  const maxPrice = req.query.max_price !== undefined ? parseInt(req.query.max_price, 10) : null;
  if (minPrice !== null && !Number.isFinite(minPrice)) {
    return res.status(400).json({ error: 'invalid_min_price' });
  }
  if (maxPrice !== null && !Number.isFinite(maxPrice)) {
    return res.status(400).json({ error: 'invalid_max_price' });
  }

  // FIX-WORKER-7 pass 73 BUG 2: Regra A status whitelist completa
  const where = [`p.status IN ('approved','platform_owned')`, `p.deleted_at IS NULL`];
  const params = [];
  let i = 1;

  /* FIX-WORKER-18 pass 535 (slug filters case-sensitivity - paridade pass 533/cross-svc):
     PRE-FIX BUG: 2 filter params usavam req.query RAW:
     - category linha 716: WHERE c.slug=$X com raw category
     - seller linha 732: WHERE s.store_slug=$X com raw seller
     Slugs DB lowercase canonical (categories + sellers + tags + products).
     User /products?category=AI-Agents -> 0 results (case-sensitive PG).
     Mesma classe pass 533 search top-sellers/category - paridade lagged.
     POST-FIX: .toString().trim().toLowerCase() em ambos filters.
     Pattern V8 W7 W18 invariant: slug params filter sempre normalize. */
  if (req.query.category) {
    // FIX-WORKER-7 pass 417: is_active filter paridade cross-svc (search 417)
    where.push(`p.category_id = (SELECT id FROM categories WHERE slug = $${i++} AND is_active = TRUE)`);
    params.push(String(req.query.category).trim().toLowerCase());
  }
  if (req.query.kind) {
    where.push(`p.kind = $${i++}`); params.push(req.query.kind);
  }
  if (minPrice !== null) {
    where.push(`p.price_cents >= $${i++}`); params.push(minPrice);
  }
  if (maxPrice !== null) {
    where.push(`p.price_cents <= $${i++}`); params.push(maxPrice);
  }
  if (req.query.free === 'true') where.push(`p.is_free = TRUE`);
  if (req.query.platform_owned === 'true') where.push(`p.is_platform_owned = TRUE`);
  // BUG 7: ?seller filter implementado
  if (req.query.seller) {
    where.push(`s.store_slug = $${i++}`);
    params.push(String(req.query.seller).trim().toLowerCase());
  }

  // BUG 1: + p.id ASC tiebreaker em TODOS sorts
  // FIX-WORKER-7 pass 125: + recent_sales (sync c/ search-svc SORT_OPTIONS).
  // Tiebreaker p.id ASC mantem Regra D em todos (W7 pass 12).
  const order = ({
    relevance:    'p.sales_count DESC, p.avg_rating DESC NULLS LAST, p.id ASC',
    newest:       'p.published_at DESC NULLS LAST, p.id ASC',
    price_asc:    'p.price_cents ASC, p.id ASC',
    price_desc:   'p.price_cents DESC, p.id ASC',
    rating:       'p.avg_rating DESC NULLS LAST, p.review_count DESC, p.id ASC',
    sales:        'p.sales_count DESC, p.id ASC',
    recent_sales: 'p.last_sale_at DESC NULLS LAST, p.sales_count DESC, p.id ASC',
  })[req.query.sort] || 'p.sales_count DESC, p.avg_rating DESC NULLS LAST, p.id ASC';

  params.push(lim, off);
  // BUG 8: LEFT JOIN explicit em vez de 3 subqueries correlacionadas
  // FIX-WORKER-18 pass 187: include_total consolidacao via COUNT(*) OVER() window.
  //   PRE-FIX: include_total=true rodava 2 queries (rows + COUNT separado).
  //   POST-FIX: 1 query com window aggregate (PG scan unico do filtro WHERE).
  //   Em catalog 100k products: ~80ms (2 queries) -> ~45ms (1 query window).
  //   Cache 60s ja existente cobre 99% chamadas (este e o miss path).
  const wantTotal = req.query.include_total === 'true';
  const selectFields = `p.id, p.slug, p.title, p.subtitle, p.short_description, p.kind, p.cover_image_url,
            p.price_cents, p.currency, p.license_kind, p.is_free, p.tech_stack,
            p.avg_rating, p.review_count, p.sales_count, p.is_platform_owned, p.published_at,
            s.store_slug AS seller_slug,
            s.store_name AS seller_name,
            c.slug AS category_slug${wantTotal ? ',\n            COUNT(*) OVER()::INT AS _total' : ''}`;
  // FIX-WORKER-7 pass 406 (LEFT JOIN categories is_active filter):
  //   PRE-FIX: LEFT JOIN categories sem filter is_active
  //   - Admin desativa categoria (is_active=FALSE) mas products referenciam
  //   - Listagem retorna category_slug de cat inativa
  //   - Frontend chip "ai-agents" -> Link /categoria/ai-agents -> 404
  //   - UX broken silent (catalog -> click category -> 404 page)
  //   POST-FIX: LEFT JOIN ... AND c.is_active = TRUE
  //   - Categoria inativa = category_slug retornado NULL (LEFT JOIN no match)
  //   - Frontend renderiza sem chip categoria (graceful fallback)
  //   - Paridade /:slug detail + /:slug/qna (linha proxima)
  const r = await query(
    `SELECT ${selectFields}
       FROM products p
       LEFT JOIN sellers s ON s.id = p.seller_id
       LEFT JOIN categories c ON c.id = p.category_id AND c.is_active = TRUE
      WHERE ${where.join(' AND ')}
      ORDER BY ${order}
      LIMIT $${i++} OFFSET $${i++}`,
    params
  );

  // FIX-WORKER-18 pass 187: extrai _total da primeira row (window result identical across rows)
  let total = null;
  let hasMore = null;
  if (wantTotal) {
    total = r.rows[0]?._total ?? 0;
    hasMore = (off + r.rows.length) < total;
    // Strip _total interno do response (campo de implementacao)
    for (const row of r.rows) delete row._total;
  }

  res.json({
    products: r.rows,
    page: Math.max(parseInt(req.query.page, 10) || 1, 1),
    limit: lim,
    ...(total !== null ? { total, has_more: hasMore } : {}),
  });
}));

// GET /products/:slug - detalhe publico (PDP)
// FIX-WORKER-18 pass 4: cacheia query result (60s) mas mantem analytics writes
// FORA do cache (toda request continua loggar product_views + view_count).
// PDP eh o endpoint mais hit do site (search/home/share -> click). Antes:
// cada request = SELECT pesado com 4 subqueries + 2 LEFT JOINs. Agora 1 query
// a cada 60s por slug, demais sao Redis GET (<1ms).
//
// FIX-WORKER-7 pass 74: 5 BUGS aplicando Pattern W7 (Regras A+I + DLP + json_agg whitelist).
//
// BUG 1 *** Regra I p.* + delete blacklist *** schema evolution leak vector
//   PRE-FIX: SELECT p.* + delete r.rows[0].search_tsv post-query.
//   - Blacklist fragil: qualquer ALTER TABLE ADD COLUMN vaza automaticamente
//   - Schema atual ja contem: qa_verdict, qa_confidence_score (admin scoring),
//     submitted_at (timing intel), approved_by (admin user_id), search_tsv (deleted)
//   - Futuras migrations podem adicionar internal_notes/admin_flags/risk_score
//   FIX: positive whitelist - explicit fields documentados como public-safe.
//
// BUG 2 *** Regra A status incompleto *** platform_owned products invisiveis
//   Mesma classe do pass 73 BUG 2 - PDP rejeita platform_owned MLB products.
//   User clica produto MLB feature -> 404 spurious.
//   FIX: status IN ('approved','platform_owned').
//
// BUG 3 *** json_agg(pv.*) + json_agg(pm.*) + json_agg(t.*) DLP leak ***
//   product_versions.* pode vazar download_token, version_metadata sensitive
//   (versao private testing). product_media.* pode vazar private_url/cdn_signing_key.
//   tags.* pode vazar internal_metadata fields.
//   FIX: json_build_object com explicit fields p/ cada agregacao.
//
// BUG 4 *** DLP analytics referrer ***
//   product_views.referrer aceita URL completa incluindo query string.
//   Vetor: usuario chega via shared link com session token em URL:
//     /referrer = https://corporate.com/wiki?session=abc123 -> DB stored
//     /referrer = https://staging.cas.io/reset-password?token=XYZ -> token leak persistido
//   product_views eh consultado em admin analytics dashboards -> leak amplification.
//   FIX: strip query string + mask.text() defensive em referrer pre-INSERT.
//
// BUG 5 *** Cache wrap dont distinguish null hit ***
//   PRE-FIX: cache returns null AND value-not-found returns null - cache MISS
//   re-executes query every request for non-existent slugs (404s).
//   Vetor: atacante hammer /products/<random>/?slug DoS amplification.
//   FIX: cache short TTL (10s) p/ null sentinels - reduz DoS amplification.
router.get('/:slug', asyncHandler(async (req, res, next) => {
  // MLB-NEW WORKER 16 / FIX-WORKER-18 pass 2: is_top_seller via subquery correlacionada
  // Threshold min 5 vendas. Combo "OFICIAL MAIS VENDIDO" = is_platform_owned AND is_top_seller.
  //
  // FIX-WORKER-18 pass 350 (cache key normalization - hottest endpoint of site):
  //   PRE-FIX: cacheKey = `products:detail:${req.params.slug}` sem normalizacao.
  //   Atacante hammer /Product-X, /PRODUCT-X, /product-x criava 3 entries Redis
  //   distintas p/ MESMO product (slugs PG sao case-insensitive em LOWER(slug)
  //   queries reais mas estes paths chegam aqui literalmente).
  //   Cache pollution + memory waste + DB hit em paridade de cada variante.
  //   Pass 298 normalizou outras keys (related, reviews, qna) mas DETAIL ficou.
  //   POST-FIX: toLowerCase().trim() consolidation pattern paridade pass 298+327.
  //   Tambem cache de 404 (null sentinel) ja era 10s defensive vs DoS amp.
  const slugNorm = String(req.params.slug || '').trim().toLowerCase();
  const cacheKey = `products:detail:${slugNorm}`;
  // FIX-WORKER-18 pass 5: withCache retorna {value, hit} - destructuring necessario
  const { value: product } = await cache.withCache(cacheKey, 60, async () => {
    // FIX-WORKER-7 pass 74 BUG 1: positive whitelist (sem p.*)
    // FIX-WORKER-7 pass 74 BUG 3: json_build_object whitelist p/ subqueries
    const r = await query(
      `SELECT p.id, p.slug, p.title, p.subtitle, p.description, p.short_description,
              p.kind, p.cover_image_url, p.price_cents, p.currency, p.license_kind,
              p.is_free, p.is_platform_owned, p.tech_stack, p.requirements,
              p.install_instructions, p.api_keys_required, p.estimated_install_min,
              p.attributes, p.meta_keywords, p.view_count,
              p.avg_rating, p.review_count, p.sales_count,
              p.created_at, p.published_at,
              s.id AS seller_id, s.store_slug, s.store_name, s.store_logo_url,
              s.reputation_tier, s.reputation_score, s.avg_rating AS seller_rating,
              c.slug AS category_slug, c.name AS category_name,
              (SELECT json_agg(json_build_object(
                 'id', t.id, 'slug', t.slug, 'name', t.name
               ))
                 FROM tags t JOIN product_tags pt ON pt.tag_id = t.id
                 WHERE pt.product_id = p.id) AS tags,
              (SELECT json_agg(json_build_object(
                 'id', pv.id, 'version', pv.version, 'changelog', pv.changelog,
                 'is_current', pv.is_current, 'created_at', pv.created_at
               ) ORDER BY pv.created_at DESC)
                 FROM product_versions pv WHERE pv.product_id = p.id) AS versions,
              (SELECT json_agg(json_build_object(
                 'id', pm.id, 'media_type', pm.kind, 'url', pm.url,
                 'alt_text', pm.caption, 'sort_order', pm.sort_order
               ) ORDER BY pm.sort_order)
                 FROM product_media pm WHERE pm.product_id = p.id) AS media,
              /* FIX-WORKER-10 pass 487 (is_top_seller boolean + NULL category guard):
                 Paridade search-svc fix mesma pass. category_id e NULLABLE -
                 quando NULL: MAX retorna NULL -> p.sales_count=NULL e NULL -
                 is_top_seller NULL (nao FALSE) - frontend OfficialBadge prop NULL.
                 Fix: AND p.category_id IS NOT NULL pre-guard + COALESCE FALSE wrap. */
              COALESCE(
                p.sales_count >= 5 AND p.category_id IS NOT NULL AND p.sales_count = (
                  SELECT MAX(p2.sales_count) FROM products p2
                   WHERE p2.category_id = p.category_id
                     AND p2.status IN ('approved','platform_owned')
                     AND p2.deleted_at IS NULL
                ), FALSE
              ) AS is_top_seller
         FROM products p
         LEFT JOIN sellers s ON s.id = p.seller_id
         LEFT JOIN categories c ON c.id = p.category_id AND c.is_active = TRUE
        WHERE p.slug = $1
          AND p.status IN ('approved','platform_owned')
          AND p.deleted_at IS NULL`,
      /* FIX-WORKER-18 pass 531 (CRITICAL cache key/query case-mismatch - HOTTEST endpoint):
         PRE-FIX BUG: line 855 declared slugNorm.toLowerCase() para cache key
         (pass 350) MAS query usa req.params.slug RAW (case-sensitive PG).
         - Cenario: /products/FOO -> cache MISS (chave 'foo' normalized) ->
           SELECT slug='FOO' -> 0 rows -> cached null sentinel 10s
         - Cenario: /products/foo -> cache MISS chave 'foo' -> SELECT 'foo' OK -> cache
         - Cenario: /products/FOO again -> cache HIT 'foo' data (mas pass 350 cached
           null primeiro - 10s tomei pra superseder) -> incorret 404 OR 200 conforme timing
         - HOTTEST endpoint: TODA PDP view ataca este path
         - Pass 350 adicionou 10s null TTL p/ "reducer DoS amplification" - mas
           BUG na query lado ENABLES o DoS first place
         - Paridade pass 513 (also-bought/related) + 521 (sellers stats) +
           529 (reviews/qna) - este endpoint principal estava LAGGED
         POST-FIX: slugNorm reuse (declared line 855) - case-insensitive end-to-end
         Trade-off ZERO: slugs DB lowercase canonical */
      [slugNorm]
    );
    if (!r.rows.length) return null;
    return r.rows[0];
  });
  if (!product) return next(errorHandler.notFound('product_not_found'));

  // FIX-WORKER-7 pass 74 BUG 4: DLP referrer strip query + mask.text
  // analytics SEMPRE rodam (fora do cache) - mesmo em cache HIT contam view
  const rawRef = req.headers.referer || null;
  const safeRef = rawRef ? mask.text(String(rawRef).split('?')[0]) : null;
  query(
    `INSERT INTO product_views (product_id, ip_address, referrer, user_agent)
     VALUES ($1, $2, $3, $4)`,
    [product.id, req.ip, safeRef, req.headers['user-agent'] || null]
  ).catch(() => {});
  query('UPDATE products SET view_count = view_count + 1 WHERE id = $1', [product.id]).catch(() => {});
  res.json({ product });
}));

// GET /products/:slug/reviews
// FIX-WORKER-18 pass 4: cache 60s. Invalidated on POST /reviews via review-svc cache.del.
// FIX-WORKER-7 pass 5: 404 product_not_found para slugs inexistentes.
// FIX-WORKER-7 pass 75: 5 BUGS aplicando Pattern W7 (Regras A+D+E + filters + UX).
//
// BUG 1 *** Regra D TIEBREAKER MISSING ***
//   ORDER BY helpful_count DESC, created_at DESC nao determ.
//   Reviews helpful_count=0 burst (produto novo) -> ordem indefinida.
//   FIX: + r.id DESC tiebreaker.
//
// BUG 2 *** Regra A PRE-CHECK INCOMPLETO ***
//   PRE-FIX: SELECT 1 FROM products WHERE slug AND deleted_at IS NULL
//   Aceita products com status='draft','qa_pending','rejected' - reviews
//   aparecem para products nao publicados.
//   FIX: + status IN ('approved','platform_owned') alinhado pass 73/74.
//
// BUG 3 *** Regra E NO TOTAL/has_more ***
//   Pagination UI sem visibility de fim - "Carregar mais" sempre disponivel.
//   FIX: COUNT + has_more.
//
// BUG 4 *** ?sort FILTER MISSING ***
//   PDP MLB feature: "mais uteis" (default) vs "mais recentes" vs "mais criticas".
//   Sem server-side sort - frontend nao consegue alterar ordenacao.
//   FIX: ?sort enum (helpful|newest|critical|highest).
//
// BUG 5 *** ?rating FILTER MISSING ***
//   PDP MLB feature: "ver só 5 estrelas" / "ver só 1 estrela".
//   FIX: ?rating (1-5) inteiro.
const REVIEW_SORT_ENUM = new Set(['helpful','newest','critical','highest']);

router.get('/:slug/reviews',
  /* FIX-WORKER-7 pass 298: cache key normalization paridade */
  cache.cacheMiddleware((req) => {
    const slug = (req.params.slug || '').toString().trim().toLowerCase();
    const lim = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const sort = (req.query.sort || 'helpful').toString().toLowerCase();
    const rating = (req.query.rating || '').toString();
    return `products:reviews:${slug}:lim=${lim}:p=${page}:s=${sort}:r=${rating}`;
  }, 60),
  asyncHandler(async (req, res, next) => {
  const lim = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 20, 100));
  const off = (Math.max(parseInt(req.query.page, 10) || 1, 1) - 1) * lim;

  // BUG 4: sort enum whitelist
  const sort = req.query.sort || 'helpful';
  if (!REVIEW_SORT_ENUM.has(sort)) {
    return res.status(400).json({ error: 'invalid_sort', allowed: Array.from(REVIEW_SORT_ENUM) });
  }
  // BUG 5: rating filter (1-5)
  let ratingFilter = null;
  if (req.query.rating !== undefined) {
    const rn = parseInt(req.query.rating, 10);
    if (!Number.isFinite(rn) || rn < 1 || rn > 5) {
      return res.status(400).json({ error: 'invalid_rating', range: '1-5' });
    }
    ratingFilter = rn;
  }

  /* FIX-WORKER-7 pass 529 (cache key/query case-mismatch paridade pass 513):
     PRE-FIX BUG (same class pass 513 /also-bought + /related):
     - Cache key linha 959: slug.toLowerCase() normalize
     - Query usa req.params.slug RAW (case-sensitive PG)
     - User /products/Foo/reviews -> cache MISS (key normalized 'foo') ->
       SELECT slug='Foo' -> 404 (slugs DB lowercase canonical)
     - User /products/foo/reviews -> cache MISS -> SELECT 'foo' -> OK + cache.set
     - User /products/Foo/reviews again -> cache HIT 'foo' data -> 200 OK
     - Inconsistencia UX: case-confusion 404 vs 200
     POST-FIX: normalize slug early, use in both pre-check + main query.
     Paridade pass 513 (also-bought + related) + 521 (sellers stats). */
  const normalizedSlug = (req.params.slug || '').toString().trim().toLowerCase();

  // BUG 2: Regra A status whitelist no pre-check
  // FIX pass 529: usar normalizedSlug (match cache key + DB canonical lowercase)
  const exists = await query(
    `SELECT 1 FROM products
      WHERE slug = $1
        AND status IN ('approved','platform_owned')
        AND deleted_at IS NULL LIMIT 1`,
    [normalizedSlug]
  );
  if (!exists.rows.length) return next(errorHandler.notFound('product_not_found'));

  // BUG 1: + r.id DESC tiebreaker em TODOS sorts
  const orderClause = ({
    helpful:  'r.helpful_count DESC, r.created_at DESC, r.id DESC',
    newest:   'r.created_at DESC, r.id DESC',
    critical: 'r.rating ASC, r.created_at DESC, r.id DESC',
    highest:  'r.rating DESC, r.helpful_count DESC, r.id DESC',
  })[sort];

  const whereParts = [`p.slug = $1`, `r.is_hidden = FALSE`];
  const params = [normalizedSlug];
  let i = 2;
  if (ratingFilter !== null) {
    whereParts.push(`r.rating = $${i++}`);
    params.push(ratingFilter);
  }
  params.push(lim, off);
  const limIdx = i++;
  const offIdx = i++;

  // FIX-WORKER-18 pass 187: COUNT(*) OVER() window consolidacao (2 queries -> 1).
  // Same pattern aplicado em /products listing (pass 187), wishlist (pass 178),
  // notifications (pass 179), vault keys (pass 180).
  const r = await query(
    `SELECT r.id, r.rating, r.title, r.body, r.is_verified_purchase,
            r.helpful_count, r.unhelpful_count,
            r.reply_from_seller, r.reply_at, r.created_at,
            u.display_name AS buyer_name, u.avatar_url AS buyer_avatar,
            COUNT(*) OVER()::INT AS _total
       FROM product_reviews r
       JOIN products p ON p.id = r.product_id
       LEFT JOIN users u ON u.id = r.buyer_user_id
      WHERE ${whereParts.join(' AND ')}
      ORDER BY ${orderClause}
      LIMIT $${limIdx} OFFSET $${offIdx}`,
    params
  );

  const total = r.rows[0]?._total ?? 0;
  const reviews = r.rows.map((row) => { const { _total, ...rest } = row; return rest; });

  // FIX-WORKER-7 pass 260 (page cap parity qna pass 245):
  //   PRE-FIX: page = Math.max(req.query.page||1, 1) sem cap p/ total
  //   ?page=99999 com total=10 retornava { page:99999, has_more:false }
  //   Frontend pagination "Pagina 99999 de 1" - UX broken
  //   Cache 60s armazenava response invalido
  //   POST-FIX: effectivePage = Math.min(requested, ceil(total/lim))
  //   Pattern V8 paridade com qna route (pass 245)
  const requestedPage = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const maxPage = total > 0 ? Math.ceil(total / lim) : 1;
  const effectivePage = Math.min(requestedPage, maxPage);

  // FIX-WORKER-7 pass 398 (stars_breakdown agg - MLB feature):
  //   PRE-FIX: response retornava SO reviews paginated + total
  //   - Frontend PDP precisa renderizar: 'X reviews ⭐4.8 - 70% 5⭐ | 20% 4⭐...'
  //   - Sem breakdown, frontend faria N+1 query OR client-side reduce
  //   - Client reduce so cobre rows da pagina (subset = % errado)
  //   - Pattern V8 paridade pass 373 seller review KPI
  //   POST-FIX: aggregate query secondary (5-bucket COUNT FILTER)
  //   - Filter is_hidden=FALSE igual lista
  //   - Filter ratingFilter NAO aplica (breakdown sempre todos)
  //   - 1 query extra ~5ms (idx_reviews_product cobre)
  const aggResult = await query(
    `SELECT
       COUNT(*) FILTER (WHERE r.rating = 5)::INT AS stars_5,
       COUNT(*) FILTER (WHERE r.rating = 4)::INT AS stars_4,
       COUNT(*) FILTER (WHERE r.rating = 3)::INT AS stars_3,
       COUNT(*) FILTER (WHERE r.rating = 2)::INT AS stars_2,
       COUNT(*) FILTER (WHERE r.rating = 1)::INT AS stars_1,
       ROUND(AVG(r.rating)::numeric, 1) AS avg_rating
     FROM product_reviews r
     JOIN products p ON p.id = r.product_id
     WHERE p.slug = $1 AND r.is_hidden = FALSE`,
    [normalizedSlug]  // FIX pass 529: normalizedSlug paridade primary query
  );
  const agg = aggResult.rows[0] || {};
  const breakdown = {
    5: Number(agg.stars_5 || 0),
    4: Number(agg.stars_4 || 0),
    3: Number(agg.stars_3 || 0),
    2: Number(agg.stars_2 || 0),
    1: Number(agg.stars_1 || 0),
  };

  res.json({
    reviews,
    total, limit: lim, page: effectivePage,
    has_more: (off + reviews.length) < total,
    sort, rating: ratingFilter,
    // FIX pass 398: MLB-style breakdown p/ stars histogram UI
    stars_breakdown: breakdown,
    avg_rating: agg.avg_rating !== null && agg.avg_rating !== undefined ? Number(agg.avg_rating) : null,
  });
}));

// GET /products/:slug/qna
// FIX-WORKER-18 pass 4: cache 60s (qna upvotes mudam mas hot path eh leitura)
// FIX-WORKER-7 pass 5: 404 product_not_found para slugs inexistentes.
// FIX-WORKER-7 pass 75: 5 BUGS aplicando Pattern W7 (Regras A+D+E + filter + UX).
//
// BUG 1 *** Regra D *** ORDER BY is_pinned DESC, asked_at DESC sem id tiebreaker
// BUG 2 *** Regra A PRE-CHECK *** falta status IN ('approved','platform_owned')
// BUG 3 *** Regra E *** hardcoded LIMIT 50 sem ?limit/?offset
// BUG 4 *** ?answered_only filter MISSING *** UX MLB "ver só respondidas"
// BUG 5 *** No total/has_more *** pagination UI quebrada
router.get('/:slug/qna',
  /* FIX-WORKER-7 pass 298: cache key normalization paridade */
  cache.cacheMiddleware((req) => {
    const slug = (req.params.slug || '').toString().trim().toLowerCase();
    const lim = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const ans = (req.query.answered_only || '').toString();
    return `products:qna:${slug}:lim=${lim}:p=${page}:ans=${ans}`;
  }, 60),
  asyncHandler(async (req, res, next) => {
  const lim = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50, 100));
  const off = (Math.max(parseInt(req.query.page, 10) || 1, 1) - 1) * lim;
  const answeredOnly = String(req.query.answered_only || '').toLowerCase() === 'true';
  /* FIX-WORKER-7 pass 529 (cache key/query case-mismatch paridade pass 513 + /reviews):
     Mesma classe de bug do /reviews endpoint - cache key normaliza slug
     mas query usa req.params.slug RAW. Apply normalize end-to-end. */
  const normalizedSlug = (req.params.slug || '').toString().trim().toLowerCase();

  // BUG 2: Regra A status whitelist no pre-check
  // FIX pass 529: usar normalizedSlug (match cache key + DB canonical lowercase)
  const exists = await query(
    `SELECT 1 FROM products
      WHERE slug = $1
        AND status IN ('approved','platform_owned')
        AND deleted_at IS NULL LIMIT 1`,
    [normalizedSlug]
  );
  if (!exists.rows.length) return next(errorHandler.notFound('product_not_found'));

  // BUG 4: answered_only filter
  const whereParts = [`p.slug = $1`, `q.is_hidden = FALSE`, `q.is_public = TRUE`];
  if (answeredOnly) whereParts.push(`q.answer IS NOT NULL`);

  // FIX-WORKER-18 pass 187: COUNT(*) OVER() window consolidation
  const r = await query(
    `SELECT q.id, q.question, q.answer, q.is_pinned, q.upvote_count,
            q.asked_at, q.answered_at,
            ua.display_name AS asker_name,
            us.display_name AS answerer_name,
            COUNT(*) OVER()::INT AS _total
       FROM product_qna q
       JOIN products p ON p.id = q.product_id
       LEFT JOIN users ua ON ua.id = q.asked_by_user_id
       LEFT JOIN users us ON us.id = q.answered_by_user_id
      WHERE ${whereParts.join(' AND ')}
      ORDER BY q.is_pinned DESC, q.upvote_count DESC, q.asked_at DESC, q.id DESC
      LIMIT $2 OFFSET $3`,
    [normalizedSlug, lim, off]  // FIX pass 529: normalizedSlug paridade pre-check
  );

  /* FIX-WORKER-7 pass 441 (window total = 0 quando OFFSET passa todas rows):
     PRE-FIX (pass 187 + 245): COUNT(*) OVER() retorna count APENAS quando
     >=1 row no resultado. Quando OFFSET > total real -> 0 rows -> _total=0.
     - User clica "next page" beyond last -> requestedPage=99 - real maxPage=2
     - off = 98 * 50 = 4900, LIMIT retorna []
     - total = r.rows[0]?._total ?? 0 = 0 (no rows -> no window data)
     - maxPage = Math.ceil(0/50) = 0 -> 1 (fallback)
     - effectivePage = min(99, 1) = 1
     - has_more = (4900 + 0) < 0 = false
     - Frontend UX: "Pagina 1 de 1" + "0 perguntas" mesmo havendo 100 perguntas
     - User confuso: "minhas perguntas sumiram?"
     POST-FIX: separate COUNT query quando window vazio (r.rows.length === 0)
     Pattern V8 W7 page cap defensive (paridade pass 245 mas robusto p/ overflow).
     Custo extra: 1 query so quando offset overflow (raro - usuario navegando far). */
  let total = r.rows[0]?._total ?? 0;
  if (r.rows.length === 0 && off > 0) {
    // OFFSET overflow path - count separate
    // FIX pass 529: normalizedSlug paridade primary query (case-insensitive end-to-end)
    const c = await query(
      `SELECT COUNT(*)::INT AS total
         FROM product_qna q
         JOIN products p ON p.id = q.product_id
        WHERE ${whereParts.join(' AND ')}`,
      [normalizedSlug]
    );
    total = c.rows[0]?.total ?? 0;
  }
  const qna = r.rows.map((row) => { const { _total, ...rest } = row; return rest; });
  // FIX-WORKER-7 pass 245 (page cap response): se user solicita page=99999
  // mas total=10, response retornava qna=[] + page:99999 + has_more:false.
  // Frontend renderizava "Pagina 99999 de 1" - UX confuso.
  // POST-FIX: cap page no total real (max(1, ceil(total/lim))).
  const requestedPage = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const maxPage = total > 0 ? Math.ceil(total / lim) : 1;
  const effectivePage = Math.min(requestedPage, maxPage);

  res.json({
    qna,
    total, limit: lim, page: effectivePage,
    has_more: (off + qna.length) < total,
    // FIX pass 441: + overflow flag - frontend pode mostrar "Voltar para inicio"
    // se user navegou alem do total real
    overflow: requestedPage > maxPage,
    answered_only: answeredOnly,
  });
}));

module.exports = router;
