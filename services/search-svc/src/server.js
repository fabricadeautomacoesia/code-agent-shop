'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const express = require('express');
const { z } = require('zod');
const { query } = require('@cas/db-client');
const { logger, sanitize, errorHandler, asyncHandler, validate, cache } = require('@cas/shared');

const log = logger.child({ svc: 'search-svc' });
const app = express();
const PORT = parseInt(process.env.PORT_SEARCH || '3019', 10);

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(sanitize.middleware());

app.get('/health', (_req, res) => res.json({ ok: true, svc: 'search-svc' }));

// GET /search?q=...&category=...&kind=...&min_price=...&max_price=...&sort=...&page=...
app.get('/', asyncHandler(async (req, res) => {
  const t0 = Date.now();
  const q = (req.query.q || '').toString().trim();
  const category = req.query.category;
  const kind = req.query.kind;
  const min_price = req.query.min_price ? parseInt(req.query.min_price, 10) : null;
  const max_price = req.query.max_price ? parseInt(req.query.max_price, 10) : null;
  const free = req.query.free === 'true';
  const tier = req.query.tier;
  const tag = req.query.tag;
  const lim = Math.min(parseInt(req.query.limit, 10) || 24, 60);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const off = (page - 1) * lim;

  const params = [];
  let i = 1;
  const where = [`p.status = 'approved'`, `p.deleted_at IS NULL`];

  let rank_expr = '0::REAL';
  if (q) {
    where.push(`p.search_tsv @@ plainto_tsquery('portuguese', unaccent($${i}))`);
    rank_expr = `ts_rank(p.search_tsv, plainto_tsquery('portuguese', unaccent($${i})))`;
    params.push(q);
    i++;
  }
  if (category) {
    where.push(`p.category_id = (SELECT id FROM categories WHERE slug = $${i++})`);
    params.push(category);
  }
  if (kind)      { where.push(`p.kind = $${i++}`); params.push(kind); }
  if (min_price !== null) { where.push(`p.price_cents >= $${i++}`); params.push(min_price); }
  if (max_price !== null) { where.push(`p.price_cents <= $${i++}`); params.push(max_price); }
  if (free)      where.push(`p.is_free = TRUE`);
  if (tier)      { where.push(`s.reputation_tier = $${i++}`); params.push(tier); }
  if (tag) {
    where.push(`EXISTS(SELECT 1 FROM product_tags pt JOIN tags t ON t.id=pt.tag_id WHERE pt.product_id=p.id AND t.slug=$${i++})`);
    params.push(tag);
  }

  // MLB-NEW WORKER 16: filtro recently_sold (24h window) usa idx_products_last_sale partial
  if (req.query.recently_sold === '1' || req.query.recently_sold === 'true') {
    where.push(`p.last_sale_at IS NOT NULL AND p.last_sale_at > NOW() - INTERVAL '24 hours'`);
  }

  const order = ({
    relevance:    q ? `rank DESC, p.sales_count DESC` : `p.sales_count DESC, p.avg_rating DESC NULLS LAST`,
    newest:       `p.published_at DESC NULLS LAST`,
    price_asc:    `p.price_cents ASC`,
    price_desc:   `p.price_cents DESC`,
    rating:       `p.avg_rating DESC NULLS LAST, p.review_count DESC`,
    sales:        `p.sales_count DESC`,
    // MLB-NEW WORKER 16: sort por venda mais recente (combina com idx_products_last_sale)
    recent_sales: `p.last_sale_at DESC NULLS LAST, p.sales_count DESC`,
  })[req.query.sort || 'relevance'];

  params.push(lim, off);
  // MLB-NEW WORKER 16: is_top_seller. FIX-WORKER-18 pass 2: trocado MAX OVER PARTITION
  // BY (window function) por subquery correlacionada que usa idx_products_cat_sales.
  // ANTES: WindowAgg + Sort sobre TODA tabela mesmo com LIMIT N (Seq Scan + Sort O(N*log(N)))
  // AGORA: 24 index-only lookups O(log N) cada -> ~140x menos ops em 50k rows.
  // Threshold min 5 vendas. Combo "OFICIAL MAIS VENDIDO" = oficial AND top_seller.
  const sql = `
    SELECT p.id, p.slug, p.title, p.subtitle, p.short_description, p.kind,
           p.cover_image_url, p.price_cents, p.currency, p.is_free, p.tech_stack,
           p.avg_rating, p.review_count, p.sales_count, p.is_platform_owned, p.published_at,
           p.last_sale_at,
           s.store_slug, s.store_name, s.reputation_tier,
           c.slug AS category_slug, c.name AS category_name,
           (p.sales_count >= 5 AND p.sales_count = (
              SELECT MAX(p2.sales_count) FROM products p2
               WHERE p2.category_id = p.category_id
                 AND p2.status = 'approved' AND p2.deleted_at IS NULL
           )) AS is_top_seller,
           ${rank_expr} AS rank,
           fn_product_search_rank(
             ${rank_expr},
             p.sales_count, p.avg_rating, p.review_count,
             EXTRACT(DAY FROM (NOW() - p.published_at))::INT
           ) AS score
      FROM products p
      LEFT JOIN sellers s ON s.id = p.seller_id
      LEFT JOIN categories c ON c.id = p.category_id
     WHERE ${where.join(' AND ')}
     ORDER BY ${order}
     LIMIT $${i++} OFFSET $${i++}`;

  const r = await query(sql, params);

  // Total para paginacao
  const totalParams = params.slice(0, params.length - 2);
  const totalSql = `SELECT COUNT(*)::INT AS total FROM products p LEFT JOIN sellers s ON s.id = p.seller_id WHERE ${where.join(' AND ')}`;
  const t = await query(totalSql, totalParams);

  const dur = Date.now() - t0;

  // search_log assincrono
  if (q || category || kind) {
    query(
      `INSERT INTO search_log (user_id, query, query_normalized, filters, result_count, duration_ms, ip_address)
       VALUES ($1,$2,$3,$4::JSONB,$5,$6,$7)`,
      [null, q || '', q.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''),
       JSON.stringify({ category, kind, min_price, max_price, free, tier, tag, sort: req.query.sort }),
       t.rows[0].total, dur, req.ip]
    ).catch(() => {});
  }

  res.json({
    results: r.rows,
    page,
    limit: lim,
    total: t.rows[0].total,
    pages: Math.ceil(t.rows[0].total / lim),
    duration_ms: dur,
  });
}));

// GET /search/autocomplete?q=...
app.get('/autocomplete', asyncHandler(async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (q.length < 2) return res.json({ suggestions: [] });
  const r = await query(
    `SELECT DISTINCT title, slug FROM products
      WHERE status = 'approved'
        AND deleted_at IS NULL
        AND title ILIKE $1
      ORDER BY title ASC LIMIT 10`,
    [`%${q}%`]
  );
  // Sugestoes adicionais por similarity (pg_trgm)
  const sim = await query(
    `SELECT title, slug, similarity(title, $1) AS s
       FROM products WHERE status = 'approved' AND title % $1
       ORDER BY s DESC LIMIT 10`, [q]
  ).catch(() => ({ rows: [] }));

  const merged = [...r.rows, ...sim.rows];
  const unique = Array.from(new Map(merged.map((x) => [x.slug, x])).values()).slice(0, 10);
  res.json({ suggestions: unique });
}));

// GET /search/top-sellers - mais vendidos POR CATEGORIA (V8 - MLB style)
// Retorna agrupado: { [category_slug]: [products...] }
// FIX-WORKER-10: aceita ?category=slug para filtrar uma categoria (antes era ignorado)
// FIX-WORKER-18: cache 120s - top-sellers muda pouco (sales_count atualiza por order paid)
app.get('/top-sellers',
  cache.cacheMiddleware((req) => `search:top-sellers:per=${req.query.per_category || 4}:cat=${req.query.category || ''}`, 120),
  asyncHandler(async (req, res) => {
  const perCategory = Math.min(parseInt(req.query.per_category || '4', 10), 12);
  const catFilter = (req.query.category || '').toString().trim();
  const r = await query(
    `WITH ranked AS (
       SELECT p.*, c.slug AS cat_slug, c.name AS cat_name,
              ROW_NUMBER() OVER (PARTITION BY p.category_id ORDER BY p.sales_count DESC) AS rn
         FROM products p
         JOIN categories c ON c.id = p.category_id
        WHERE p.status = 'approved' AND p.deleted_at IS NULL AND c.parent_id IS NULL
          AND ($2::TEXT IS NULL OR $2 = '' OR c.slug = $2)
     )
     SELECT id, slug, title, subtitle, short_description, kind, cover_image_url,
            price_cents, currency, is_free, tech_stack, avg_rating, review_count,
            sales_count, is_platform_owned, cat_slug, cat_name, rn,
            CASE WHEN rn = 1 THEN TRUE ELSE FALSE END AS is_top_seller
       FROM ranked
      WHERE rn <= $1
      ORDER BY cat_name, rn`, [perCategory, catFilter || null]
  );
  const grouped = {};
  for (const p of r.rows) {
    if (!grouped[p.cat_slug]) grouped[p.cat_slug] = { name: p.cat_name, products: [] };
    grouped[p.cat_slug].products.push(p);
  }
  res.json({ categories: grouped, filter: catFilter || null });
}));

// GET /search/top-sellers/:category - mais vendidos de UMA categoria
// FIX-WORKER-10: valida slug + retorna 404 quando inexistente + enriquece com metadata
// Antes: slug invalido retornava {products:[]} igual a categoria vazia -> UX impossivel de diferenciar.
app.get('/top-sellers/:category', asyncHandler(async (req, res) => {
  const lim = Math.min(parseInt(req.query.limit || '12', 10), 50);
  // 1) Resolve categoria e valida existencia
  const catR = await query(
    `SELECT id, slug, name, name_singular, description, parent_id
       FROM categories WHERE slug = $1`, [req.params.category]
  );
  if (!catR.rows.length) {
    return res.status(404).json({ error: 'category_not_found', slug: req.params.category });
  }
  const cat = catR.rows[0];
  // 2) Top sellers da categoria
  const r = await query(
    `SELECT p.id, p.slug, p.title, p.subtitle, p.short_description, p.kind,
            p.cover_image_url, p.price_cents, p.currency, p.is_free,
            p.tech_stack, p.avg_rating, p.review_count, p.sales_count,
            p.is_platform_owned, p.published_at,
            (SELECT store_slug FROM sellers WHERE id = p.seller_id) AS store_slug,
            (SELECT store_name FROM sellers WHERE id = p.seller_id) AS store_name,
            (SELECT reputation_tier FROM sellers WHERE id = p.seller_id) AS reputation_tier,
            ROW_NUMBER() OVER (ORDER BY p.sales_count DESC) AS sales_rank
       FROM products p
      WHERE p.status = 'approved' AND p.deleted_at IS NULL AND p.category_id = $1
      ORDER BY p.sales_count DESC LIMIT $2`, [cat.id, lim]
  );
  res.json({
    products: r.rows,
    category: { slug: cat.slug, name: cat.name, name_singular: cat.name_singular, description: cat.description, parent_id: cat.parent_id },
  });
}));

// GET /search/trending - top buscas dos ultimos 7 dias
// cache 300s - trending recalcula janela 7 dias
app.get('/trending',
  cache.cacheMiddleware(() => 'search:trending', 300),
  asyncHandler(async (_req, res) => {
  const r = await query(
    `SELECT query_normalized, COUNT(*) AS count
       FROM search_log
      WHERE created_at > NOW() - INTERVAL '7 days'
        AND query_normalized != ''
      GROUP BY query_normalized
      ORDER BY count DESC LIMIT 20`
  );
  res.json({ trending: r.rows });
}));

// GET /search/categories - mega menu
// cache 900s - categorias mudam raramente (admin only)
app.get('/categories',
  cache.cacheMiddleware(() => 'search:categories', 900),
  asyncHandler(async (_req, res) => {
  const r = await query(
    `SELECT c.*,
       (SELECT json_agg(c2.* ORDER BY c2.sort_order) FROM categories c2 WHERE c2.parent_id = c.id) AS children
       FROM categories c WHERE c.parent_id IS NULL AND c.is_active
       ORDER BY c.sort_order`
  );
  res.json({ categories: r.rows });
}));

// GET /search/facets?category=...&q=... - opcoes para filtros laterais
// cache 180s - facets agrega counts em products (muda em new product / order)
app.get('/facets',
  cache.cacheMiddleware((req) => `search:facets:cat=${req.query.category || ''}:kind=${req.query.kind || ''}`, 180),
  asyncHandler(async (req, res) => {
  const r = await query(
    `SELECT
       (SELECT json_agg(json_build_object('kind', kind, 'count', cnt))
          FROM (SELECT kind, COUNT(*) AS cnt FROM products WHERE status='approved' GROUP BY kind) k) AS kinds,
       (SELECT json_agg(json_build_object('tier', reputation_tier, 'count', cnt))
          FROM (SELECT s.reputation_tier, COUNT(*) AS cnt FROM products p JOIN sellers s ON s.id=p.seller_id
                  WHERE p.status='approved' GROUP BY s.reputation_tier) t) AS seller_tiers,
       (SELECT json_build_object(
          'min', MIN(price_cents), 'max', MAX(price_cents), 'avg', AVG(price_cents)::INT
        ) FROM products WHERE status='approved') AS price_range`
  );
  res.json({ facets: r.rows[0] });
}));

app.use((req, res) => res.status(404).json({ error: 'route_not_found' }));
app.use(errorHandler.errorMiddleware);

const server = app.listen(PORT, () => log.info({ port: PORT }, '[search-svc] listening'));
['SIGINT','SIGTERM'].forEach((s) => process.on(s, () => server.close(() => process.exit(0))));
