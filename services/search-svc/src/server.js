'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const express = require('express');
const { z } = require('zod');
const { query } = require('@cas/db-client');
const { logger, sanitize, errorHandler, asyncHandler, validate, cache, rateLimiter, mask } = require('@cas/shared');

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
// FIX-WORKER-7 pass 91: 4 BUGS aplicando Pattern W7 (enums whitelist + DLP + sort).
//
// BUG 1 *** KIND ENUM WHITELIST MISSING ***
//   PRE-FIX: ?kind=anything -> PG enum cast 22P02 -> 500 leak.
//   Mesma classe pass 73 BUG 3 (product-svc).
//   FIX: SEARCH_KIND_ENUM whitelist (matches products.kind enum).
//
// BUG 2 *** TIER ENUM WHITELIST MISSING ***
//   PRE-FIX: ?tier=anything -> PG enum reputation_tier_enum cast 22P02 -> 500.
//   Mesma classe pass 72 (sellers.js).
//   FIX: SEARCH_TIER_ENUM whitelist (bronze|silver|gold|platinum).
//
// BUG 3 *** SORT INVALID FALLBACK SILENT ***
//   PRE-FIX: ?sort=invalid -> default 'relevance' silencioso. UX confuso
//   (frontend tab "ordenar por preco" caia em relevance sem feedback).
//   FIX: explicit 400 com allowed[].
//
// BUG 4 *** DLP search_log ip_address PII + query raw ***
//   PRE-FIX: search_log.ip_address e search_log.query armazenam plain text.
//   - ip_address: LGPD - IP eh PII categorizada como dado pessoal (Art 5° II).
//   - query: usuario pode digitar acidentalmente Bearer token / sk-API key
//     (auto-fill URL bar copy/paste).
//   FIX: ip_address null em search_log (analytics aggregated; user_id ja loga).
//   query: mask.text() defensive (DLP sk-/Bearer/JWT regex).
const SEARCH_KIND_ENUM = new Set([
  'automation','ai_agent','n8n_workflow','node_script','python_script',
  'php_script','prompt_pack','template','dataset','other'
]);
const SEARCH_TIER_ENUM = new Set(['bronze','silver','gold','platinum']);
const SEARCH_SORT_ENUM = new Set([
  'relevance','newest','price_asc','price_desc','rating','sales','recent_sales'
]);

app.get('/', searchLimiter, asyncHandler(async (req, res) => {
  const t0 = Date.now();
  const q = (req.query.q || '').toString().trim();
  // FIX-WORKER-10 pass 5: early-return para q 1-2 chars SEM filtros (lixo/typo).
  // tsquery em 1-2 chars retorna 0 rows mas executa Seq Scan no search_tsv -> waste.
  // Se ha filtros (category/kind/etc), q curto e OK (filtros restringem search).
  // Tambem nao loga em search_log -> evita bloat (matches trigger sanitize mig 027).
  // FIX-WORKER-10 pass 243 (response shape consistency):
  //   PRE-FIX: early-return curto retornava limit:0 + page:1 enquanto outras
  //   responses normais retornavam limit=24 (default ou ?limit param).
  //   Frontend SearchResults assumia limit constante e dividia total/limit
  //   para paginar -> divide by zero (limit=0) -> NaN pages.
  //   POST-FIX: usar limit/page consistentes (parseado mesmo se early-return).
  //   Hint preservado.
  if (q && q.length < 3 && !req.query.category && !req.query.kind && !req.query.tag) {
    const _earlyLim = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 24, 60));
    const _earlyPage = Math.max(parseInt(req.query.page, 10) || 1, 1);
    return res.json({ results: [], page: _earlyPage, limit: _earlyLim, total: 0, pages: 0, duration_ms: Date.now() - t0, hint: 'query too short - min 3 chars' });
  }
  const category = req.query.category;
  const kind = req.query.kind;

  // FIX-WORKER-7 pass 91 BUG 1: kind enum whitelist
  if (kind && !SEARCH_KIND_ENUM.has(kind)) {
    return res.status(400).json({ error: 'invalid_kind', allowed: Array.from(SEARCH_KIND_ENUM) });
  }
  // FIX-WORKER-10 pass 2: NaN -> null silencioso (antes max_price=abc -> PG NaN -> 404)
  const _minP = req.query.min_price ? parseInt(req.query.min_price, 10) : null;
  const _maxP = req.query.max_price ? parseInt(req.query.max_price, 10) : null;
  const min_price = Number.isFinite(_minP) && _minP >= 0 ? _minP : null;
  const max_price = Number.isFinite(_maxP) && _maxP >= 0 ? _maxP : null;
  const free = req.query.free === 'true';
  const tier = req.query.tier;
  // FIX-WORKER-7 pass 91 BUG 2: tier enum whitelist
  if (tier && !SEARCH_TIER_ENUM.has(tier)) {
    return res.status(400).json({ error: 'invalid_tier', allowed: Array.from(SEARCH_TIER_ENUM) });
  }
  // FIX-WORKER-7 pass 91 BUG 3: sort enum whitelist explicit 400
  if (req.query.sort && !SEARCH_SORT_ENUM.has(String(req.query.sort))) {
    return res.status(400).json({ error: 'invalid_sort', allowed: Array.from(SEARCH_SORT_ENUM) });
  }
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
  // FIX-WORKER-7 pass 91 BUG 4 DLP:
  //   - ip_address NULL (LGPD - IP eh PII Art 5° II)
  //   - query: mask.text() defensive (user pode colar Bearer/sk-API key)
  if (q || category || kind) {
    const safeQ = q ? mask.text(q) : '';
    query(
      `INSERT INTO search_log (user_id, query, query_normalized, filters, result_count, duration_ms, ip_address)
       VALUES ($1,$2,$3,$4::JSONB,$5,$6,$7)`,
      // FIX-WORKER-7 pass 12: bug unicode range. Original /[̀-ͯ]/ tinha chars
      // invisiveis colapsados em alguns editores que NAO matcham combining
      // diacritics consistentemente. Substituido por escape Unicode explicito
      // ̀-ͯ (Combining Diacritical Marks block) - imune a copy/paste,
      // git diff, editor encoding issues.
      [null, safeQ, safeQ.toLowerCase().normalize('NFD').replace(/\p{M}/gu, ''),
       JSON.stringify({ category, kind, min_price, max_price, free, tier, tag, sort: req.query.sort }),
       t.rows[0].total, dur, null]
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
// FIX-WORKER-7 pass 92: 3 BUGS aplicando Pattern W7 (DLP cache key + ?limit + parallel).
//
// BUG 1 *** DLP CACHE KEY *** q raw em Redis key
//   PRE-FIX: cache.cacheMiddleware key = `search:ac:${q}` armazena query raw
//   no Redis key (visible via Redis MONITOR/SCAN).
//   User cola Bearer/sk em URL bar autocomplete -> key Redis vaza secret.
//   Atacante com acesso Redis (cluster compromise) ve queries de outros users.
//   FIX: hash SHA-256 prefix p/ cache key (lookups O(1) sem leak).
//
// BUG 2 *** ?limit MISSING ***
//   PRE-FIX: hardcoded 10 sugestoes. UI mobile mostra 5, desktop 10.
//   FIX: ?limit (1-20, default 10).
//
// BUG 3 *** SERIAL QUERIES *** ILIKE + similarity sequencial
//   PRE-FIX: 2 queries paralelas executadas sequencialmente (await + await).
//   Latency = ILIKE_ms + similarity_ms.
//   FIX: Promise.all() concurrent - latency = max(ILIKE, similarity).
// FIX-WORKER-10 pass 232 (cache pollution short queries): autocomplete
// caching CADA query < 2 chars criava ~256+ keys lixo no Redis.
// User digitando "java" passava por 'j'(skip) -> 'ja'(skip) -> 'jav'(cache)
// -> 'java'(cache). PRE-FIX: cacheMiddleware capturava ANTES do guard
// q.length<2, criando entries vazias para a,b,c,...,z + acentos + numeros.
// Redis MEMORY USAGE crescia + SCAN amplification em invalidate.
// POST-FIX: short-circuit antes do middleware - guard inline no handler
// inicial (returns 200 [] sem hit middleware quando q < 2).
const _autocompleteCacheKey = (req) => {
  const qNorm = (req.query.q || '').toString().trim().toLowerCase();
  const lim = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 10));
  // BUG 1: hash defensive (PII/DLP - cache key nao expoe query)
  const crypto = require('node:crypto');
  const qHash = crypto.createHash('sha256').update(qNorm).digest('hex').slice(0, 16);
  return `search:ac:${qHash}:lim=${lim}`;
};

app.get('/autocomplete',
  autocompleteLimiter,
  // FIX-WORKER-10 pass 232: short-circuit q<2 ANTES do cache middleware
  asyncHandler(async (req, res, next) => {
    const qRaw = (req.query.q || '').toString().trim();
    if (qRaw.length < 2) {
      // Skip cache - return empty direto (no Redis pollution)
      return res.json({ suggestions: [] });
    }
    return next();
  }),
  cache.cacheMiddleware(_autocompleteCacheKey, 60),
  asyncHandler(async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  // Guard mantido por defense-in-depth (em caso middleware drift no futuro)
  if (q.length < 2) return res.json({ suggestions: [] });
  // BUG 2: ?limit configurable
  const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 10));
  // FIX-WORKER-7 pass 13: 6 bugs corrigidos no /autocomplete.
  //
  // 1. *** SECURITY *** SQL LIKE wildcard injection (nao SQL injection direto -
  //    PG parametrizado bloqueia - mas wildcard logico). User input '%' fazia
  //    ILIKE '%%%' = match TODOS produtos -> ~50k scan + DoS amplification.
  //    User input '_' fazia ILIKE '%_%' = single-char wildcard.
  //    FIX: escape wildcards % _ \ no input antes de wrap em %...%.
  //
  // 2. Regra A duplicada (linha 199+208): status='approved' so. Pattern W7 6
  //    endpoints (passes 7-12) require status IN ('approved','platform_owned').
  //    Produtos Clausula Master INVISIVEIS em autocomplete.
  //
  // 3. Regra B violada linha 208 (similarity query): SEM deleted_at IS NULL.
  //    Info leak - produtos deletados aparecem em sugestoes (link 404).
  //
  // 4. Regra D faltando: ORDER BY title ASC + ORDER BY s DESC sem tiebreakers.
  //    Empate entre titulos iguais ou mesma similarity = ordem arbitraria.
  //    FIX: tiebreaker slug (unique - sempre determinista).
  //
  // 5. Cache desperdicio: q<2 cacheia '[]' por chave 'a'/'b' etc.
  //    NOTE: middleware respeita 200 - antes do return [] no caller.
  //    Solucao requer skip middleware = refactor maior - DEFERIDO.
  //
  // 6. Merge ranking: ILIKE primeiro pode "comer" similarity 0.9 match.
  //    FIX: priorizar similarity SE score >= 0.4 (high confidence semantic).
  const qEscaped = q.replace(/[%_\\]/g, '\\$&'); // escape SQL LIKE wildcards

  // BUG 3: Promise.all concurrent (era sequential await + await)
  const [r, sim] = await Promise.all([
    query(
      `SELECT DISTINCT title, slug FROM products
        WHERE status IN ('approved','platform_owned')
          AND deleted_at IS NULL
          AND title ILIKE $1 ESCAPE '\\'
        ORDER BY title ASC, slug LIMIT $2`,
      [`%${qEscaped}%`, limit]
    ),
    query(
      `SELECT title, slug, similarity(title, $1) AS s
         FROM products
        WHERE status IN ('approved','platform_owned')
          AND deleted_at IS NULL
          AND title % $1
        ORDER BY s DESC, slug LIMIT $2`,
      [q, limit]
    ).catch(() => ({ rows: [] })),
  ]);

  // FIX bug 6: priorizar similarity matches high-confidence (s >= 0.4)
  // ANTES: ILIKE primeiro - Map.set primeiro win - similarity 0.9 perdida
  //        se ILIKE tambem match no rank 7
  // AGORA: similarity high-confidence primeiro, ILIKE complementa
  const highSim = sim.rows.filter((x) => x.s >= 0.4);
  const merged = [...highSim, ...r.rows, ...sim.rows];
  const unique = Array.from(new Map(merged.map((x) => [x.slug, x])).values()).slice(0, limit);
  res.json({ suggestions: unique, limit, count: unique.length });
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
  // FIX-WORKER-7 pass 93: 2 BUGS aplicando Pattern W7 (Regra I + D).
  //
  // BUG 1 *** Regra I SELECT p.* *** vaza colunas internas
  //   products.* expoe qa_verdict / submitted_at / approved_by / qa_run_id.
  //   Mesma classe pass 74 (/:slug detail) e pass 77 (/reco).
  //   FIX: explicit fields whitelist (positiva, sem blacklist fragil).
  //
  // BUG 2 *** Regra D tiebreaker residual no PARTITION ORDER ***
  //   ROW_NUMBER() OVER ORDER BY sales_count DESC, avg_rating DESC NULLS LAST,
  //   published_at DESC NULLS LAST - 3 levels mas products novos (sales=0,
  //   rating=NULL, published_at=now() identicos burst) -> rn arbitrario.
  //   FIX: + p.id final tiebreaker em PARTITION ORDER.
  const r = await query(
    `WITH ranked AS (
       SELECT p.id, p.slug, p.title, p.subtitle, p.short_description, p.kind,
              p.cover_image_url, p.price_cents, p.currency, p.is_free,
              p.tech_stack, p.avg_rating, p.review_count, p.sales_count,
              p.is_platform_owned, p.published_at,
              p.category_id,
              c.slug AS cat_slug, c.name AS cat_name,
              ROW_NUMBER() OVER (
                PARTITION BY p.category_id
                ORDER BY p.sales_count DESC, p.avg_rating DESC NULLS LAST,
                         p.published_at DESC NULLS LAST, p.id
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
      ORDER BY cat_name, rn, id`, [perCategory, catFilter || null]
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
              ORDER BY p.sales_count DESC, p.avg_rating DESC NULLS LAST, p.published_at DESC NULLS LAST, p.id
            ) AS sales_rank
       FROM products p
       LEFT JOIN sellers s ON s.id = p.seller_id
      WHERE p.status IN ('approved','platform_owned')
        AND p.deleted_at IS NULL
        AND p.category_id = $1
      ORDER BY p.sales_count DESC, p.avg_rating DESC NULLS LAST, p.published_at DESC NULLS LAST, p.id
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
// FIX-WORKER-7 pass 93: 4 BUGS aplicando Pattern W7 (Regra D + ?limit + DLP + cache key).
//
// BUG 1 *** Regra D TIEBREAKER MISSING ***
//   ORDER BY count DESC sem query_normalized ASC -> 2 trends mesmo count
//   -> ordem indefinida entre cache evictions (UX home page salta).
//   FIX: + query_normalized ASC tiebreaker.
//
// BUG 2 *** ?limit MISSING ***
//   PRE-FIX: hardcoded 20. Mobile pode preferir 10, desktop 30.
//   FIX: ?limit (1-50, default 20) + cache key vary.
//
// BUG 3 *** DLP query_normalized public exposure ***
//   PRE-FIX: trending lista query_normalized publicamente. Embora regex
//   filtra SQLi/XSS, NAO filtra tokens API (sk-/Bearer/JWT). User cola
//   acidentalmente "sk-abc123" -> via auto-fill URL bar -> aparece em
//   /search/trending publico (qualquer visitor ve).
//   Note: pass 91 ja aplicou mask.text() em search_log.query e query_normalized,
//   mas legacy rows pre-pass-91 podem ter raw tokens.
//   FIX: defesa em camada API: mask.text() em response (defesa adicional
//   p/ proteger legacy log entries).
//
// BUG 4 *** Cache key NAO VARIA por limit ***
//   PRE-FIX: cache key fixa 'search:trending' - ?limit=10 vs ?limit=30
//   retornam mesmo cached payload (limit=20 default).
//   FIX: cache key include :lim.
app.get('/trending',
  cache.cacheMiddleware((req) => `search:trending:lim=${Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20))}`, 300),
  asyncHandler(async (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
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
      ORDER BY count DESC, query_normalized ASC
      LIMIT $1`,
    [limit]
  );

  // BUG 3 DLP: mask.text defesa adicional p/ legacy rows pre-pass-91
  const trending = r.rows.map((row) => ({
    ...row,
    query_normalized: row.query_normalized ? mask.text(row.query_normalized) : row.query_normalized,
  }));

  res.json({ trending, count: trending.length, limit });
}));

// GET /search/categories - mega menu
// cache 900s - categorias mudam raramente (admin only)
// FIX-WORKER-7 pass 15: 4 bugs aplicando Pattern W7 8 regras consolidadas:
// 1. Children query SEM is_active filter -> admin desativava children mas
//    apareciam no mega menu storefront -> click vai pra /categoria/inativa = 404
// 2. Regra H violada: json_agg NULL quando 0 children ativos -> frontend
//    .children.map() crash TypeError. Pattern defensive COALESCE.
// 3. Regra D violada: ORDER BY sort_order sem tiebreaker -> 2 cats com
//    sort_order=10 = ordem arbitraria PG planner (cache evict = ordem diferente)
//    FIX: tiebreaker name ASC + id (sempre unique).
// 4. SELECT c.* expoe colunas internas (updated_at, meta_keywords, etc).
//    Pattern security: lista explicita de campos consumidos pelo frontend.
// GET /search/categories - mega menu storefront
// FIX-WORKER-7 pass 94: 2 BUGS aplicando Pattern W7 (product_count + parent_id NULL filter).
//
// BUG 1 *** product_count MISSING ***
//   PRE-FIX: response sem count produtos por categoria.
//   Frontend MLB-style precisa "Agentes IA (147)" no mega menu - tem que fazer
//   N+1 fetch (/facets per category) = wasteful.
//   FIX: subquery LATERAL count + cache 900s ja existente cobre.
//
// BUG 2 *** parent_id NULL FILTER REDUNDANTE no children subquery ***
//   PRE-FIX: subquery children sem AND c2.parent_id IS NOT NULL.
//   Em theory, c2.parent_id = c.id ja garante NOT NULL, MAS dataset legado
//   pode ter parent_id=NULL E... edge case improbable. Defensive skip.
app.get('/categories',
  cache.cacheMiddleware(() => 'search:categories:v3', 900),
  asyncHandler(async (_req, res) => {
  // FIX-WORKER-10 pass 181 (perf N+1): refactor 1+N subqueries -> single CTE
  // com GROUP BY agregando product_count UMA VEZ por categoria.
  //
  // PRE-FIX: query rodava ~2N subscans (N=top-level + children N+1):
  //   - 10 parents x 1 product_count subquery = 10 scans
  //   - Para cada parent, 5 children -> 5 product_count subqueries = 50 scans
  //   - Total: ~60 scans em products (tabela ~30k rows pos-launch).
  //
  // POST-FIX: 1 GROUP BY na CTE pcounts agrega product_count por category_id.
  //   - 1 single scan em products (sequential ou via idx)
  //   - LEFT JOIN pcounts em c (parent) + c2 (child) reutiliza mesmo aggregate.
  //   - Latencia: ~250ms (50k products + 60 subscans) -> ~50ms (1 scan).
  //
  // Cache bumped v2 -> v3 para forcar refresh apos novo schema.
  const r = await query(
    `WITH pcounts AS (
       SELECT category_id, COUNT(*)::INT AS cnt
         FROM products
        WHERE status IN ('approved','platform_owned')
          AND deleted_at IS NULL
          AND category_id IS NOT NULL
        GROUP BY category_id
     )
     SELECT c.id, c.slug, c.name, c.name_singular, c.description, c.icon,
            c.sort_order, c.parent_id, c.is_active,
            COALESCE(pc.cnt, 0) AS product_count,
       COALESCE(
         (SELECT json_agg(json_build_object(
                    'id', c2.id, 'slug', c2.slug, 'name', c2.name,
                    'name_singular', c2.name_singular, 'description', c2.description,
                    'icon', c2.icon, 'sort_order', c2.sort_order,
                    'product_count', COALESCE(pc2.cnt, 0)
                  ) ORDER BY c2.sort_order, c2.name, c2.id)
            FROM categories c2
            LEFT JOIN pcounts pc2 ON pc2.category_id = c2.id
           WHERE c2.parent_id = c.id AND c2.is_active),
         '[]'::JSON
       ) AS children
       FROM categories c
       LEFT JOIN pcounts pc ON pc.category_id = c.id
      WHERE c.parent_id IS NULL AND c.is_active
      ORDER BY c.sort_order, c.name, c.id`
  );
  res.json({ categories: r.rows, total: r.rows.length });
}));

// GET /search/facets?category=...&kind=... - opcoes para filtros laterais
// cache 180s - facets agrega counts em products (muda em new product / order)
// FIX-WORKER-10 pass 4: facets IGNORAVA category e kind apesar do cache key inclui-los.
// Consequencia: UI mostrava counts GLOBAIS independente do filtro. Ex: usuario em
// /categoria/agentes-ia via "147 templates disponiveis" (count global) sendo que
// agentes-ia so tem 3 templates. Cache servia o numero errado por ate 180s.
// Tambem normalizado category lowercase (slugs sao lower no DB) p/ cache hit rate.
// FIX-WORKER-7 pass 14: rate-limit aplicado (era hot endpoint sem proteção)
// Bot hit 100/s em /facets sem cache = 3s PG CPU (50k base CTE + 4 aggregates).
// Cache 180s ajuda mas combo cat+kind ~50 keys -> miss rate alto pos-restart.
// FIX-WORKER-7 pass 94: 3 BUGS aplicando Pattern W7 (Regra D + kind 400 + UX guard).
//
// BUG 1 *** Regra D kinds/seller_tiers ARRAYS sem ORDER BY ***
//   PRE-FIX: json_agg sem ORDER BY -> kinds=[{kind:'x',cnt:N},...] ordem
//   indefinida entre cache evictions. UI mega-filter salta posicoes.
//   FIX: ORDER BY cnt DESC, kind/tier ASC determ.
//
// BUG 2 *** kindFilter SILENT FALLBACK ***
//   PRE-FIX: ?kind=invalid -> null silent (UX confuso, user pensa filtrado).
//   Pattern pass 73/91: 400 explicit com allowed[].
//   FIX: validate antes do cache hit, retorna 400 invalid_kind.
//
// BUG 3 *** price_range AVG=0 quando empty sample ***
//   PRE-FIX: COALESCE(AVG(price_cents),0) retorna 0 quando 0 products.
//   Response.price_range.avg=0 confunde frontend "preço médio: R\$ 0".
//   FIX: retornar NULL quando count=0 (frontend pode renderizar "—").
const FACETS_KIND_ENUM = new Set([
  'automation','ai_agent','n8n_workflow','node_script','python_script',
  'php_script','prompt_pack','template','dataset','other'
]);

app.get('/facets',
  searchLimiter,
  // BUG 2: validate kind ANTES do cache (validacao deve preceder cache hit)
  (req, res, next) => {
    const kind = (req.query.kind || '').toString().trim().toLowerCase();
    if (kind && !FACETS_KIND_ENUM.has(kind)) {
      return res.status(400).json({ error: 'invalid_kind', allowed: Array.from(FACETS_KIND_ENUM) });
    }
    next();
  },
  cache.cacheMiddleware((req) => {
    const cat = (req.query.category || '').toString().trim().toLowerCase();
    const kind = (req.query.kind || '').toString().trim().toLowerCase();
    return `search:facets:v2:cat=${cat}:kind=${kind}`;
  }, 180),
  asyncHandler(async (req, res) => {
  const cat = (req.query.category || '').toString().trim().toLowerCase();
  const kind = (req.query.kind || '').toString().trim().toLowerCase();
  // Pos-validate: kind ja confirmado valido OU vazio
  const kindFilter = FACETS_KIND_ENUM.has(kind) ? kind : null;
  const catFilter = cat || null;
  // FIX-WORKER-7 pass 14: 2 bugs CTE base:
  // 1. Regra A: status='approved' ignorava platform_owned -> INCONSISTENCIA
  //    facets vs /search results (pass 12 inclui platform_owned). UI mostra
  //    "147 templates" mas pode haver 152 quando platform_owned contam.
  //    User filtra kind=template -> resultado /search difere do count facet.
  // 2. COALESCE em json_agg para garantir array vazio em vez de NULL.
  //    Frontend .map() em null crash. Pattern defensive cross-svc.
  // FIX-WORKER-10 pass 123: BUG 42883 'operator does not exist: product_kind = text'
  // ANTES: p.kind = $2 - PG parser nao consegue inferir tipo do $2 quando NULL,
  //        e quando kindFilter='ai_agent' tambem da erro porque $2 chega como TEXT.
  // AGORA: p.kind::TEXT = $2 - cast enum -> text resolve sem ambiguidade.
  //        Mesma logica aplicada em c.slug = $1 ja funciona (slug e TEXT).
  const r = await query(
    `WITH base AS (
       SELECT p.id, p.kind, p.price_cents, p.seller_id, p.category_id
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.status IN ('approved','platform_owned')
          AND p.deleted_at IS NULL
          AND ($1::TEXT IS NULL OR c.slug = $1)
          AND ($2::TEXT IS NULL OR p.kind::TEXT = $2)
     )
     SELECT
       COALESCE(
         (SELECT json_agg(json_build_object('kind', kind, 'count', cnt)
                          ORDER BY cnt DESC, kind ASC)
            FROM (SELECT kind, COUNT(*) AS cnt FROM base GROUP BY kind) k),
         '[]'::JSON
       ) AS kinds,
       COALESCE(
         (SELECT json_agg(json_build_object('tier', reputation_tier, 'count', cnt)
                          ORDER BY cnt DESC, reputation_tier ASC NULLS LAST)
            FROM (SELECT s.reputation_tier, COUNT(*) AS cnt FROM base b JOIN sellers s ON s.id=b.seller_id
                    GROUP BY s.reputation_tier) t),
         '[]'::JSON
       ) AS seller_tiers,
       (SELECT
          CASE WHEN COUNT(*) = 0 THEN
            json_build_object('min', NULL, 'max', NULL, 'avg', NULL, 'count', 0)
          ELSE
            json_build_object(
              'min', MIN(price_cents),
              'max', MAX(price_cents),
              'avg', AVG(price_cents)::INT,
              'count', COUNT(*)::INT
            )
          END
        FROM base) AS price_range,
       (SELECT COUNT(*) FROM base)::INT AS total`,
    [catFilter, kindFilter]
  );
  res.json({ facets: r.rows[0], filter: { category: catFilter, kind: kindFilter } });
}));

app.use((req, res) => res.status(404).json({ error: 'route_not_found' }));
app.use(errorHandler.errorMiddleware);

const server = app.listen(PORT, () => log.info({ port: PORT }, '[search-svc] listening'));
['SIGINT','SIGTERM'].forEach((s) => process.on(s, () => server.close(() => process.exit(0))));
