'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const express = require('express');
const { z } = require('zod');
const { query } = require('@cas/db-client');
const { logger, sanitize, errorHandler, asyncHandler, validate, cache, rateLimiter } = require('@cas/shared');

const log = logger.child({ svc: 'search-svc' });
const app = express();
const PORT = parseInt(process.env.PORT_SEARCH || '3019', 10);

app.disable('x-powered-by');
// FIX-WORKER-10 pass 6: trust proxy para rate-limit usar IP real (X-Forwarded-For do gateway).
// Sem isso, todos requests do gateway viam mesmo IP -> ban global ao primeiro burst.
app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));
app.use(sanitize.middleware());

// FIX-WORKER-10 pass 6: rate-limit por IP em endpoints public hot.
// /autocomplete eh hit por keystroke - bot scraping pode hammerar.
// /search e mais pesado mas tambem expoe ao publico.
// Limites generous (humanos legit nao atingem) mas barram bots:
// - /search: 30 req/min por IP (1 req/2s sustentado)
// - /autocomplete: 60 req/min por IP (1 req/s sustentado, typing rapido OK)
const searchLimiter = rateLimiter.createLimiter({ windowMs: 60_000, max: 30 });
const autocompleteLimiter = rateLimiter.createLimiter({ windowMs: 60_000, max: 60 });

app.get('/health', (_req, res) => res.json({ ok: true, svc: 'search-svc' }));

// GET /search?q=...&category=...&kind=...&min_price=...&max_price=...&sort=...&page=...
app.get('/', searchLimiter, asyncHandler(async (req, res) => {
  const t0 = Date.now();
  const q = (req.query.q || '').toString().trim();
  // FIX-WORKER-10 pass 5: early-return para q 1-2 chars SEM filtros (lixo/typo).
  // tsquery em 1-2 chars retorna 0 rows mas executa Seq Scan no search_tsv -> waste.
  // Se ha filtros (category/kind/etc), q curto e OK (filtros restringem search).
  // Tambem nao loga em search_log -> evita bloat (matches trigger sanitize mig 027).
  if (q && q.length < 3 && !req.query.category && !req.query.kind && !req.query.tag) {
    return res.json({ results: [], page: 1, limit: 0, total: 0, pages: 0, duration_ms: Date.now() - t0, hint: 'query too short - min 3 chars' });
  }
  const category = req.query.category;
  const kind = req.query.kind;
  // FIX-WORKER-10 pass 2: NaN -> null silencioso (antes max_price=abc -> PG NaN -> 404)
  const _minP = req.query.min_price ? parseInt(req.query.min_price, 10) : null;
  const _maxP = req.query.max_price ? parseInt(req.query.max_price, 10) : null;
  const min_price = Number.isFinite(_minP) && _minP >= 0 ? _minP : null;
  const max_price = Number.isFinite(_maxP) && _maxP >= 0 ? _maxP : null;
  const free = req.query.free === 'true';
  const tier = req.query.tier;
  const tag = req.query.tag;
  // FIX-WORKER-10 pass 2: Math.max para barrar limit negativo (era 500 do PG LIMIT -5)
  const lim = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 24, 60));
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const off = (page - 1) * lim;

  const params = [];
  let i = 1;
  // FIX-WORKER-7 pass 12 (Regra A): status IN ('approved','platform_owned').
  // Antes: produtos Clausula Master Revenda Direta (is_platform_owned=TRUE)
  // INVISIVEIS em /search principal - quebrava UX (clientes nao encontravam).
  // Pattern W7 pass 9/10/11 consolidado em 6 endpoints.
  const where = [`p.status IN ('approved','platform_owned')`, `p.deleted_at IS NULL`];

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

  // FIX-WORKER-10 pass 2: fallback gracioso para sort invalido (era 500 database_error
  // quando ORDER BY undefined caia no SQL). Whitelist explicito + default.
  // FIX-WORKER-7 pass 12 (Regra D): tiebreakers deterministicos em TODOS sorts.
  // Antes: 'sales' so DESC sales_count, 'relevance' so rank+sales -> empate
  // arbitrario entre produtos com mesmo valor (UX layout "salta" entre cache evicts).
  // Pattern W7 pass 11 (/top-sellers) - 3-tier: principal + avg_rating + published_at.
  const SORT_OPTIONS = {
    relevance:    q
      ? `rank DESC, p.sales_count DESC, p.avg_rating DESC NULLS LAST, p.id`
      : `p.sales_count DESC, p.avg_rating DESC NULLS LAST, p.published_at DESC NULLS LAST, p.id`,
    newest:       `p.published_at DESC NULLS LAST, p.id`,
    price_asc:    `p.price_cents ASC, p.sales_count DESC, p.id`,
    price_desc:   `p.price_cents DESC, p.sales_count DESC, p.id`,
    rating:       `p.avg_rating DESC NULLS LAST, p.review_count DESC, p.id`,
    sales:        `p.sales_count DESC, p.avg_rating DESC NULLS LAST, p.published_at DESC NULLS LAST, p.id`,
    // MLB-NEW WORKER 16: sort por venda mais recente (combina com idx_products_last_sale)
    recent_sales: `p.last_sale_at DESC NULLS LAST, p.sales_count DESC, p.id`,
  };
  const sortKey = String(req.query.sort || 'relevance');
  const order = SORT_OPTIONS[sortKey] || SORT_OPTIONS.relevance;

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
           -- FIX-WORKER-7 pass 12 (Regra A): subquery is_top_seller tinha
           -- mesma omissao de platform_owned. Inconsistente com WHERE principal
           -- (linha 60 corrigido nesta iter). Agora alinhado: ambos consideram
           -- approved + platform_owned p/ calculo do badge "MAIS VENDIDO".
           (p.sales_count >= 5 AND p.sales_count = (
              SELECT MAX(p2.sales_count) FROM products p2
               WHERE p2.category_id = p.category_id
                 AND p2.status IN ('approved','platform_owned')
                 AND p2.deleted_at IS NULL
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
      // FIX-WORKER-7 pass 12: bug unicode range. Original /[̀-ͯ]/ tinha chars
      // invisiveis colapsados em alguns editores que NAO matcham combining
      // diacritics consistentemente. Substituido por escape Unicode explicito
      // ̀-ͯ (Combining Diacritical Marks block) - imune a copy/paste,
      // git diff, editor encoding issues.
      // Pre-fix: query_normalized podia manter acentos dependendo do binary
      // do arquivo -> trigger sanitize mig 027 nao matcheava buscas.
      [null, q || '', q.toLowerCase().normalize('NFD').replace(/\p{M}/gu, ''),
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
// FIX-WORKER-18 pass 1: cache 60s - autocomplete e o endpoint mais chamado
// (1 req por keystroke do SearchBar). Mesmas queries repetem MUITO entre users.
// TTL curto (60s) garante que produtos novos aparecem rapido nas sugestoes.
// Key normaliza q lowercase + trim p/ maximizar hit rate.
app.get('/autocomplete',
  autocompleteLimiter,
  cache.cacheMiddleware((req) => `search:ac:${(req.query.q || '').toString().trim().toLowerCase()}`, 60),
  asyncHandler(async (req, res) => {
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
  // FIX-WORKER-7 pass 11: 2 bugs (pattern W7 pass 9/10):
  // 1. status = 'approved' ignorava platform_owned (Clausula Master Revenda copy)
  //    -> produtos da plataforma INVISIVEIS em top-sellers global
  // 2. ORDER BY sales_count DESC sem tiebreaker -> empate arbitrario entre
  //    produtos novos com sales_count=0 (mudava entre cache evictions)
  const r = await query(
    `WITH ranked AS (
       SELECT p.*, c.slug AS cat_slug, c.name AS cat_name,
              ROW_NUMBER() OVER (
                PARTITION BY p.category_id
                ORDER BY p.sales_count DESC, p.avg_rating DESC NULLS LAST, p.published_at DESC NULLS LAST
              ) AS rn
         FROM products p
         JOIN categories c ON c.id = p.category_id
        WHERE p.status IN ('approved','platform_owned')
          AND p.deleted_at IS NULL
          AND c.parent_id IS NULL
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
// FIX-WORKER-18 pass 1: cache 180s. Categoria page e SSR (revalidate=30 mas chamadas
// via render-on-demand somam). top-sellers/:category roda 3 subqueries por linha
// (sellers x3) - cache poupa CPU + DB pool. Key inclui params + limit.
app.get('/top-sellers/:category',
  cache.cacheMiddleware((req) => `search:top-sellers:cat=${req.params.category}:lim=${req.query.limit || 12}`, 180),
  asyncHandler(async (req, res) => {
  // FIX-WORKER-7 pass 4: Math.max(1, ...) clamp p/ rejeitar negativos
  const lim = Math.max(1, Math.min(parseInt(req.query.limit || '12', 10), 50));
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
  // FIX-WORKER-7 pass 11: 4 bugs (pattern W7 pass 9/10 aplicado):
  // 1. status = 'approved' ignorava platform_owned (Clausula Master Revenda copy)
  // 2. 3 subqueries (store_slug, store_name, reputation_tier) por linha ->
  //    LIMIT 50 max = 150 scans extras sellers. FIX: LEFT JOIN sellers unico.
  // 3. ORDER BY sales_count DESC sem tiebreaker -> empate arbitrario entre
  //    produtos novos com sales_count=0. FIX: avg_rating + published_at tiebreakers.
  // 4. Response sem 'limit' (pass 9/10 incluiu p/ frontend validar shape).
  const r = await query(
    `SELECT p.id, p.slug, p.title, p.subtitle, p.short_description, p.kind,
            p.cover_image_url, p.price_cents, p.currency, p.is_free,
            p.tech_stack, p.avg_rating, p.review_count, p.sales_count,
            p.is_platform_owned, p.published_at,
            s.store_slug, s.store_name, s.reputation_tier,
            ROW_NUMBER() OVER (
              ORDER BY p.sales_count DESC, p.avg_rating DESC NULLS LAST, p.published_at DESC NULLS LAST
            ) AS sales_rank
       FROM products p
       LEFT JOIN sellers s ON s.id = p.seller_id
      WHERE p.status IN ('approved','platform_owned')
        AND p.deleted_at IS NULL
        AND p.category_id = $1
      ORDER BY p.sales_count DESC, p.avg_rating DESC NULLS LAST, p.published_at DESC NULLS LAST
      LIMIT $2`, [cat.id, lim]
  );
  res.json({
    products: r.rows,
    category: { slug: cat.slug, name: cat.name, name_singular: cat.name_singular, description: cat.description, parent_id: cat.parent_id },
    limit: lim,
  });
}));

// GET /search/trending - top buscas dos ultimos 7 dias
// cache 300s - trending recalcula janela 7 dias
// FIX-WORKER-10 pass 3: bug detectado por audit - SQL injection/XSS attempts
// apareciam como trending publicos. Ex: "'; drop table products;--" exibido na home.
// Filtros aplicados:
// 1. CHAR_LENGTH >= 3 (queries 1-2 chars sao lixo/typo)
// 2. NOT LIKE '%''%' AND NOT LIKE '%--%' AND NOT LIKE '%<%' (filtra SQLi/XSS)
// 3. ~ '^[\w\s\-]+$' (apenas alphanum + espaco + hifen via regex POSIX)
// 4. COUNT >= 2 (1 ocorrencia nao e trend - reduz spam de bot)
app.get('/trending',
  cache.cacheMiddleware(() => 'search:trending', 300),
  asyncHandler(async (_req, res) => {
  const r = await query(
    `SELECT query_normalized, COUNT(*) AS count
       FROM search_log
      WHERE created_at > NOW() - INTERVAL '7 days'
        AND query_normalized != ''
        AND CHAR_LENGTH(query_normalized) >= 3
        AND query_normalized !~ '[''"<>;\\\\]'
        AND query_normalized NOT ILIKE '%--%'
        AND query_normalized NOT ILIKE '%/*%'
      GROUP BY query_normalized
      HAVING COUNT(*) >= 2
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

// GET /search/facets?category=...&kind=... - opcoes para filtros laterais
// cache 180s - facets agrega counts em products (muda em new product / order)
// FIX-WORKER-10 pass 4: facets IGNORAVA category e kind apesar do cache key inclui-los.
// Consequencia: UI mostrava counts GLOBAIS independente do filtro. Ex: usuario em
// /categoria/agentes-ia via "147 templates disponiveis" (count global) sendo que
// agentes-ia so tem 3 templates. Cache servia o numero errado por ate 180s.
// Tambem normalizado category lowercase (slugs sao lower no DB) p/ cache hit rate.
app.get('/facets',
  cache.cacheMiddleware((req) => {
    const cat = (req.query.category || '').toString().trim().toLowerCase();
    const kind = (req.query.kind || '').toString().trim().toLowerCase();
    return `search:facets:cat=${cat}:kind=${kind}`;
  }, 180),
  asyncHandler(async (req, res) => {
  const cat = (req.query.category || '').toString().trim().toLowerCase();
  const kind = (req.query.kind || '').toString().trim().toLowerCase();
  // Whitelist kind para evitar SQL surprise (apesar do parametrizado)
  const VALID_KINDS = new Set(['automation','ai_agent','n8n_workflow','node_script','python_script','php_script','prompt_pack','template','dataset','other']);
  const kindFilter = VALID_KINDS.has(kind) ? kind : null;
  const catFilter = cat || null;
  const r = await query(
    `WITH base AS (
       SELECT p.id, p.kind, p.price_cents, p.seller_id, p.category_id
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.status='approved' AND p.deleted_at IS NULL
          AND ($1::TEXT IS NULL OR c.slug = $1)
          AND ($2::TEXT IS NULL OR p.kind = $2)
     )
     SELECT
       (SELECT json_agg(json_build_object('kind', kind, 'count', cnt))
          FROM (SELECT kind, COUNT(*) AS cnt FROM base GROUP BY kind) k) AS kinds,
       (SELECT json_agg(json_build_object('tier', reputation_tier, 'count', cnt))
          FROM (SELECT s.reputation_tier, COUNT(*) AS cnt FROM base b JOIN sellers s ON s.id=b.seller_id
                  GROUP BY s.reputation_tier) t) AS seller_tiers,
       (SELECT json_build_object(
          'min', COALESCE(MIN(price_cents), 0),
          'max', COALESCE(MAX(price_cents), 0),
          'avg', COALESCE(AVG(price_cents)::INT, 0)
        ) FROM base) AS price_range,
       (SELECT COUNT(*) FROM base)::INT AS total`,
    [catFilter, kindFilter]
  );
  res.json({ facets: r.rows[0], filter: { category: catFilter, kind: kindFilter } });
}));

app.use((req, res) => res.status(404).json({ error: 'route_not_found' }));
app.use(errorHandler.errorMiddleware);

const server = app.listen(PORT, () => log.info({ port: PORT }, '[search-svc] listening'));
['SIGINT','SIGTERM'].forEach((s) => process.on(s, () => server.close(() => process.exit(0))));
