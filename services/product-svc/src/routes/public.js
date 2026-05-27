'use strict';

const express = require('express');
const { z } = require('zod');
const { query } = require('@cas/db-client');
const { asyncHandler, validate, errorHandler, cache, rateLimiter } = require('@cas/shared');

// FIX-WORKER-10 pass 7: rate-limit em GET / (lista publica - mais hit do site).
// 60 req/min/IP = 1 req/seg sustentado (paginacao + scroll OK). Burst alto: 429.
// /:slug detail e /reviews/qna NAO recebem rate-limit aqui pois ja sao cached
// (cache.cacheMiddleware/withCache - Redis devolve em <1ms, sem load DB).
const listLimiter = rateLimiter.createLimiter({ windowMs: 60_000, max: 60 });

const router = express.Router();

// GET /products/recommendations - para voce (MLB-6)
// Combina: 1) categorias mais vistas pelo user, 2) similar a top-rated, 3) populares globais
router.get('/recommendations/for-me',
  require('@cas/shared').jwt.requireAuth(),
  asyncHandler(async (req, res) => {
    const r = await query(
      `WITH user_categories AS (
         SELECT p.category_id, COUNT(*) AS view_count
           FROM product_views v
           JOIN products p ON p.id = v.product_id
          WHERE v.user_id = $1
            AND v.created_at > NOW() - INTERVAL '30 days'
          GROUP BY p.category_id
          ORDER BY view_count DESC
          LIMIT 3
       ),
       viewed AS (
         SELECT product_id FROM product_views WHERE user_id = $1
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
              (SELECT store_slug FROM sellers WHERE id = p.seller_id) AS store_slug,
              (SELECT store_name FROM sellers WHERE id = p.seller_id) AS store_name,
              (SELECT reputation_tier FROM sellers WHERE id = p.seller_id) AS reputation_tier,
              CASE WHEN p.category_id IN (SELECT category_id FROM user_categories) THEN 2 ELSE 1 END AS reco_score
         FROM products p
        WHERE p.status = 'approved' AND p.deleted_at IS NULL
          AND p.id NOT IN (SELECT product_id FROM in_cart_or_owned)
          AND (
            p.category_id IN (SELECT category_id FROM user_categories)
            OR p.sales_count > 100
          )
        ORDER BY reco_score DESC, p.avg_rating DESC NULLS LAST, p.sales_count DESC
        LIMIT 12`,
      [req.user.sub]
    );
    res.json({ products: r.rows });
  })
);

// MLB-NEW: GET /products/recently-viewed - "Vistos recentemente" estilo Mercado Livre
// Retorna ultimos N produtos distintos vistos pelo user nos ultimos 14 dias.
// Distinto por product_id (so a view mais recente conta), ORDER BY DESC.
router.get('/recently-viewed',
  require('@cas/shared').jwt.requireAuth(),
  asyncHandler(async (req, res) => {
    const lim = Math.max(1, Math.min(parseInt(req.query.limit || '12', 10), 30));
    const r = await query(
      `WITH last_views AS (
         SELECT product_id, MAX(created_at) AS last_view_at
           FROM product_views
          WHERE user_id = $1::UUID
            AND created_at > NOW() - INTERVAL '14 days'
          GROUP BY product_id
          ORDER BY MAX(created_at) DESC
          LIMIT $2::INT
       )
       SELECT p.id, p.slug, p.title, p.subtitle, p.short_description, p.kind,
              p.cover_image_url, p.price_cents, p.currency, p.is_free,
              p.tech_stack, p.avg_rating, p.review_count, p.sales_count,
              p.is_platform_owned, p.flash_promo_active, p.flash_promo_discount_pct,
              (SELECT store_slug FROM sellers WHERE id = p.seller_id) AS store_slug,
              (SELECT store_name FROM sellers WHERE id = p.seller_id) AS store_name,
              (SELECT reputation_tier FROM sellers WHERE id = p.seller_id) AS reputation_tier,
              lv.last_view_at
         FROM last_views lv
         JOIN products p ON p.id = lv.product_id
        WHERE p.status = 'approved' AND p.deleted_at IS NULL
        ORDER BY lv.last_view_at DESC`,
      [req.user.sub, lim]
    );
    res.json({ products: r.rows, count: r.rows.length });
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
router.get('/:slug/also-bought',
  cache.cacheMiddleware((req) => `products:also-bought:${req.params.slug}:lim=${req.query.limit || 6}`, 600),
  asyncHandler(async (req, res) => {
  const lim = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 6, 12));
  const r = await query(
    `WITH src AS (
       SELECT id FROM products WHERE slug = $1 AND status = 'approved'
     ),
     co_buyers AS (
       SELECT DISTINCT o.buyer_user_id
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         JOIN src ON src.id = oi.product_id
        WHERE o.status IN ('paid','fulfilled')
     ),
     also_bought AS (
       SELECT oi.product_id, COUNT(DISTINCT o.buyer_user_id) AS co_buyers
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         JOIN co_buyers cb ON cb.buyer_user_id = o.buyer_user_id
        WHERE o.status IN ('paid','fulfilled')
          AND oi.product_id NOT IN (SELECT id FROM src)
        GROUP BY oi.product_id
        ORDER BY co_buyers DESC, oi.product_id LIMIT $2
     )
     SELECT p.id, p.slug, p.title, p.subtitle, p.short_description, p.kind,
            p.cover_image_url, p.price_cents, p.currency, p.is_free,
            p.tech_stack, p.avg_rating, p.review_count, p.sales_count,
            p.is_platform_owned, p.flash_promo_active,
            ab.co_buyers,
            (SELECT store_slug FROM sellers WHERE id = p.seller_id) AS store_slug
       FROM also_bought ab
       JOIN products p ON p.id = ab.product_id
      WHERE p.status = 'approved' AND p.deleted_at IS NULL
      ORDER BY ab.co_buyers DESC`,
    [req.params.slug, lim]
  );
  res.json({ products: r.rows });
}));

// GET /products/:slug/related - produtos relacionados (mesma categoria, exclui o atual)
// FIX-WORKER-18 pass2: cache 300s - related products muda raramente (categoria + same tier)
router.get('/:slug/related',
  cache.cacheMiddleware((req) => `products:related:${req.params.slug}:lim=${req.query.limit || 6}`, 300),
  asyncHandler(async (req, res) => {
  const r = await query(
    `SELECT p2.id, p2.slug, p2.title, p2.subtitle, p2.short_description, p2.kind,
            p2.cover_image_url, p2.price_cents, p2.currency, p2.is_free,
            p2.tech_stack, p2.avg_rating, p2.review_count, p2.sales_count,
            p2.is_platform_owned, p2.flash_promo_active,
            (SELECT store_slug FROM sellers WHERE id = p2.seller_id) AS store_slug,
            (SELECT reputation_tier FROM sellers WHERE id = p2.seller_id) AS reputation_tier
       FROM products p1
       JOIN products p2 ON p2.category_id = p1.category_id AND p2.id <> p1.id
      WHERE p1.slug = $1 AND p2.status = 'approved' AND p2.deleted_at IS NULL
      ORDER BY p2.sales_count DESC LIMIT 6`, [req.params.slug]
  );
  res.json({ products: r.rows });
}));

// GET /products/compare?ids=uuid,uuid,uuid - comparar ate 4 produtos (MLB-7)
router.get('/compare', asyncHandler(async (req, res) => {
  const idsRaw = (req.query.ids || '').toString();
  const ids = idsRaw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 4);
  if (ids.length < 2) {
    return res.status(400).json({ error: 'min_2_products', message: 'Selecione pelo menos 2 produtos para comparar' });
  }
  const r = await query(
    `SELECT p.id, p.slug, p.title, p.subtitle, p.kind, p.cover_image_url,
            p.price_cents, p.currency, p.is_free, p.license_kind,
            p.tech_stack, p.api_keys_required, p.estimated_install_min,
            p.requirements, p.avg_rating, p.review_count, p.sales_count,
            p.is_platform_owned, p.flash_promo_active, p.flash_promo_discount_pct,
            (SELECT store_slug FROM sellers WHERE id = p.seller_id) AS store_slug,
            (SELECT store_name FROM sellers WHERE id = p.seller_id) AS store_name,
            (SELECT reputation_tier FROM sellers WHERE id = p.seller_id) AS reputation_tier,
            (SELECT name FROM categories WHERE id = p.category_id) AS category_name
       FROM products p
      WHERE p.id = ANY($1::UUID[]) AND p.status = 'approved' AND p.deleted_at IS NULL`,
    [ids]
  );
  res.json({ products: r.rows, count: r.rows.length });
}));

// GET /products/flash-promo - produtos em promocao relampago ativa (MLB-10)
// cache 60s - flash promo tem timer curto, mas ainda vale cachear janela curta
router.get('/flash-promo/active',
  cache.cacheMiddleware(() => 'products:flash-promo:active', 60),
  asyncHandler(async (req, res) => {
  const r = await query(
    `SELECT id, slug, title, subtitle, short_description, kind, cover_image_url,
            price_cents, currency, is_free, tech_stack, avg_rating, review_count,
            sales_count, is_platform_owned, flash_promo_discount_pct, flash_promo_ends_at,
            (price_cents * (1 - flash_promo_discount_pct/100))::BIGINT AS discounted_price_cents,
            EXTRACT(EPOCH FROM (flash_promo_ends_at - NOW()))::BIGINT AS seconds_remaining
       FROM products
      WHERE status = 'approved' AND flash_promo_active = TRUE
        AND flash_promo_ends_at > NOW()
        AND deleted_at IS NULL
      ORDER BY flash_promo_ends_at ASC LIMIT 20`
  );
  res.json({ products: r.rows });
}));

// GET /products - listagem + filtros facetados
// cache 60s - lista publica de produtos. Invalidada em mutations admin/me.
// FIX-WORKER-10 pass 7: rate-limit ANTES do cache para barrar bots ANTES de Redis lookup.
router.get('/',
  listLimiter,
  cache.cacheMiddleware((req) => {
    const q = req.query;
    return `products:list:cat=${q.category||''}:kind=${q.kind||''}:min=${q.min_price||''}:max=${q.max_price||''}:free=${q.free||''}:platform=${q.platform_owned||''}:seller=${q.seller||''}:sort=${q.sort||''}:lim=${q.limit||24}:page=${q.page||1}`;
  }, 60),
  asyncHandler(async (req, res) => {
  // FIX-WORKER-7 pass 3: clamp 1..60 (era Math.min apenas, deixava lim=-5 passar).
  // Antes: ?limit=-5 -> SQL "LIMIT -5" -> PG ERROR 'LIMIT must not be negative'
  // mascarado por error handler como {products:[]} 200 (UX confuso e quebra paginacao).
  // Agora: Math.max(1, Math.min(parseInt||24, 60)) garante invariant 1 <= lim <= 60.
  const lim = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 24, 60));
  const off = (Math.max(parseInt(req.query.page, 10) || 1, 1) - 1) * lim;

  const where = [`status = 'approved'`];
  const params = [];
  let i = 1;

  if (req.query.category) {
    where.push(`category_id = (SELECT id FROM categories WHERE slug = $${i++})`);
    params.push(req.query.category);
  }
  if (req.query.kind) {
    where.push(`kind = $${i++}`); params.push(req.query.kind);
  }
  if (req.query.min_price) {
    where.push(`price_cents >= $${i++}`); params.push(parseInt(req.query.min_price, 10));
  }
  if (req.query.max_price) {
    where.push(`price_cents <= $${i++}`); params.push(parseInt(req.query.max_price, 10));
  }
  if (req.query.free === 'true') where.push(`is_free = TRUE`);
  if (req.query.platform_owned === 'true') where.push(`is_platform_owned = TRUE`);

  const order = ({
    relevance:    'sales_count DESC, avg_rating DESC NULLS LAST',
    newest:       'published_at DESC NULLS LAST',
    price_asc:    'price_cents ASC',
    price_desc:   'price_cents DESC',
    rating:       'avg_rating DESC NULLS LAST, review_count DESC',
    sales:        'sales_count DESC',
  })[req.query.sort] || 'sales_count DESC, avg_rating DESC NULLS LAST';

  params.push(lim, off);
  const r = await query(
    `SELECT id, slug, title, subtitle, short_description, kind, cover_image_url,
            price_cents, currency, license_kind, is_free, tech_stack,
            avg_rating, review_count, sales_count, is_platform_owned, published_at,
            (SELECT store_slug FROM sellers WHERE id = products.seller_id) AS seller_slug,
            (SELECT store_name FROM sellers WHERE id = products.seller_id) AS seller_name,
            (SELECT slug FROM categories WHERE id = products.category_id) AS category_slug
       FROM products
      WHERE ${where.join(' AND ')} AND deleted_at IS NULL
      ORDER BY ${order}
      LIMIT $${i++} OFFSET $${i++}`,
    params
  );
  res.json({ products: r.rows });
}));

// GET /products/:slug - detalhe publico
// FIX-WORKER-18 pass 4: cacheia query result (60s) mas mantem analytics writes
// FORA do cache (toda request continua loggar product_views + view_count).
// PDP eh o endpoint mais hit do site (search/home/share -> click). Antes:
// cada request = SELECT pesado com 4 subqueries + 2 LEFT JOINs. Agora 1 query
// a cada 60s por slug, demais sao Redis GET (<1ms).
router.get('/:slug', asyncHandler(async (req, res, next) => {
  // MLB-NEW WORKER 16 / FIX-WORKER-18 pass 2: is_top_seller via subquery correlacionada
  // Threshold min 5 vendas. Combo "OFICIAL MAIS VENDIDO" = is_platform_owned AND is_top_seller.
  const cacheKey = `products:detail:${req.params.slug}`;
  // FIX-WORKER-18 pass 5: withCache retorna {value, hit} - destructuring necessario
  const { value: product } = await cache.withCache(cacheKey, 60, async () => {
    const r = await query(
      `SELECT p.*,
              s.id AS seller_id, s.store_slug, s.store_name, s.store_logo_url,
              s.reputation_tier, s.reputation_score, s.avg_rating AS seller_rating,
              c.slug AS category_slug, c.name AS category_name,
              (SELECT json_agg(t.*) FROM tags t JOIN product_tags pt ON pt.tag_id = t.id WHERE pt.product_id = p.id) AS tags,
              (SELECT json_agg(pv.* ORDER BY pv.created_at DESC) FROM product_versions pv WHERE pv.product_id = p.id) AS versions,
              (SELECT json_agg(pm.* ORDER BY pm.sort_order) FROM product_media pm WHERE pm.product_id = p.id) AS media,
              (p.sales_count >= 5 AND p.sales_count = (
                 SELECT MAX(p2.sales_count) FROM products p2
                  WHERE p2.category_id = p.category_id
                    AND p2.status = 'approved' AND p2.deleted_at IS NULL
              )) AS is_top_seller
         FROM products p
         LEFT JOIN sellers s ON s.id = p.seller_id
         LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.slug = $1 AND p.status = 'approved' AND p.deleted_at IS NULL`,
      [req.params.slug]
    );
    if (!r.rows.length) return null;
    delete r.rows[0].search_tsv;
    return r.rows[0];
  });
  if (!product) return next(errorHandler.notFound('product_not_found'));
  // analytics SEMPRE rodam (fora do cache) - mesmo em cache HIT contam view
  query(
    `INSERT INTO product_views (product_id, ip_address, referrer, user_agent)
     VALUES ($1, $2, $3, $4)`,
    [product.id, req.ip, req.headers.referer || null, req.headers['user-agent'] || null]
  ).catch(() => {});
  query('UPDATE products SET view_count = view_count + 1 WHERE id = $1', [product.id]).catch(() => {});
  res.json({ product });
}));

// GET /products/:slug/reviews
// FIX-WORKER-18 pass 4: cache 60s (reviews mudam pouco, novas reviews populam
// em background). Invalidated on POST /reviews via cache.del em review-svc.
router.get('/:slug/reviews',
  cache.cacheMiddleware((req) => `products:reviews:${req.params.slug}:lim=${req.query.limit||20}:p=${req.query.page||1}`, 60),
  asyncHandler(async (req, res) => {
  const lim = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 20, 100));
  const off = (Math.max(parseInt(req.query.page, 10) || 1, 1) - 1) * lim;
  const r = await query(
    `SELECT r.id, r.rating, r.title, r.body, r.is_verified_purchase, r.helpful_count, r.unhelpful_count,
            r.reply_from_seller, r.reply_at, r.created_at,
            u.display_name AS buyer_name, u.avatar_url AS buyer_avatar
       FROM product_reviews r
       JOIN products p ON p.id = r.product_id
       LEFT JOIN users u ON u.id = r.buyer_user_id
      WHERE p.slug = $1 AND r.is_hidden = FALSE
      ORDER BY r.helpful_count DESC, r.created_at DESC LIMIT $2 OFFSET $3`,
    [req.params.slug, lim, off]
  );
  res.json({ reviews: r.rows });
}));

// GET /products/:slug/qna
// FIX-WORKER-18 pass 4: cache 60s (qna upvotes mudam mas hot path eh leitura)
router.get('/:slug/qna',
  cache.cacheMiddleware((req) => `products:qna:${req.params.slug}`, 60),
  asyncHandler(async (req, res) => {
  const r = await query(
    `SELECT q.id, q.question, q.answer, q.is_pinned, q.upvote_count,
            q.asked_at, q.answered_at,
            ua.display_name AS asker_name,
            us.display_name AS answerer_name
       FROM product_qna q
       JOIN products p ON p.id = q.product_id
       LEFT JOIN users ua ON ua.id = q.asked_by_user_id
       LEFT JOIN users us ON us.id = q.answered_by_user_id
      WHERE p.slug = $1 AND q.is_hidden = FALSE AND q.is_public = TRUE
      ORDER BY q.is_pinned DESC, q.asked_at DESC LIMIT 50`,
    [req.params.slug]
  );
  res.json({ qna: r.rows });
}));

module.exports = router;
