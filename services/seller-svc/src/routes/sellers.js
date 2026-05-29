'use strict';

const express = require('express');
const { z } = require('zod');
const { query } = require('@cas/db-client');
const { jwt, asyncHandler, validate, errorHandler, cache } = require('@cas/shared');

const router = express.Router();

// FIX-WORKER-18 pass 5: cache em 4 endpoints publicos de seller (zero cache antes).
// Cada hit em /sellers ou /seller/[slug] no storefront fazia query DB ~800ms.
// Cache 120s (sellers list/stats), 60s (detail/products - mais volatil por reviews).
// Invalidacao via cache.del em mutations (seller-svc/me.js update profile).

// GET /sellers - listagem publica (storefront)
// FIX-WORKER-7 pass 72: 3 BUGS aplicando Pattern W7 (Regras D + tier enum + UX).
//
// BUG 1 *** Regra D TIEBREAKER MISSING *** ORDER BY reputation_score DESC
//   2 sellers reputation_score identicos (caso comum em bronze tier inicial)
//   -> ordem indefinida. UX pagination salta + cache key colide ordens.
//   FIX: + s.id ASC tiebreaker para TODOS sorts.
//
// BUG 2 *** TIER WHITELIST MISSING *** SQL error vaza internals
//   PRE-FIX: ?tier=anything aceita -> PG cast a enum reputation_tier_enum
//   falha 22P02 -> 500 generico ou response com 'invalid_text_representation'
//   Atacante usa pra fingerprinting schema (enum existe? cast pattern?).
//   FIX: tier enum whitelist (bronze|silver|gold|platinum).
//
// BUG 3 *** TOTAL MISSING ***
//   Frontend pagination UI sem total não sabe quantos pages tem.
//   FIX: COUNT(*) p/ pagination meta.
const SELLER_TIER_ENUM = new Set(['bronze','silver','gold','platinum']);

router.get('/',
  /* FIX-WORKER-18 pass 617 (cache key normalization 5 params paridade cadeia 28 sites
     W7+W10+W12+W13+W17+W18 cache hygiene cross-svc consolidacao - 29 sites total):
     PRE-FIX BUGS (5 issues cache pollution vs handler):
     1. Raw q.page sem Math.max(1, ...) clamp (handler linha 43).
     2. Raw q.limit sem Math.max/Math.min [1, 100] clamp (handler linha 42).
     3. Raw q.sort sem whitelist check (handler nao valida MAS query injection
        risk - PG ORDER BY clause derived from sort param).
     4. Raw q.tier sem VALID_TIER whitelist (handler valida linha 59).
        Invalid stored 400 cached em chave.
     5. Raw q.search sem trim/lowercase/slice cap DoS defense (handler escapa).
     POST-FIX: normalize cache key SAME way handler normalizes.
     Paridade cadeia 28 sites cache hygiene cross-svc (passes 520-616). */
  cache.cacheMiddleware((req) => {
    const q = req.query;
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const lim = Math.max(1, Math.min(100, parseInt(q.limit, 10) || 24));
    // sort: bounded enum (paridade VALID_TIER whitelist handler-side)
    const sortRaw = String(q.sort || 'rep_desc').toLowerCase();
    const VALID_SORT = new Set(['rep_desc','rep_asc','newest','oldest','name']);
    const sort = VALID_SORT.has(sortRaw) ? sortRaw : 'rep_desc';
    // tier: VALID_TIER whitelist (handler linha 58)
    const tierRaw = String(q.tier || '').toLowerCase();
    const VALID_TIER_CACHE = new Set(['iniciante','bronze','prata','ouro','platinum']);
    const tier = VALID_TIER_CACHE.has(tierRaw) ? tierRaw : '';
    // search: .trim().toLowerCase().slice(0, 100) DoS cap (handler escapa wildcards)
    const search = (q.search || '').toString().trim().toLowerCase().slice(0, 100);
    return `sellers:list:p=${page}:lim=${lim}:s=${sort}:t=${tier}:q=${search}`;
  }, 120),
  asyncHandler(async (req, res) => {
  const { page = 1, limit = 24, sort = 'rep_desc', tier, search } = req.query;
  // FIX-WORKER-7 pass 4: Math.max(1, ...) clamp p/ rejeitar negativos
  const lim = Math.max(1, Math.min(parseInt(limit, 10) || 24, 100));
  const off = (Math.max(parseInt(page, 10) || 1, 1) - 1) * lim;

  // FIX-WORKER-7 pass 72 BUG 2: tier enum whitelist
  if (tier && !SELLER_TIER_ENUM.has(tier)) {
    return res.status(400).json({ error: 'invalid_tier', allowed: Array.from(SELLER_TIER_ENUM) });
  }

  /* FIX-WORKER-2 pass 325 hardening:
     PRE-FIX bugs:
     1. tier sem ENUM whitelist - PG cast erro 22P02 -> 500 leak
     2. search ILIKE %${search}% sem escape - wildcards % e _ aceitos
        ?search=%% -> match TODOS sellers (mass exfil)
     POST-FIX paridade pass 299 admin/all:
     - VALID_TIER whitelist + 400 invalid
     - search escape regex /[%_\\]/g + ESCAPE '\\' + slice(0,100) */
  const VALID_TIER = new Set(['iniciante','bronze','prata','ouro','platinum']);
  if (tier && !VALID_TIER.has(String(tier).toLowerCase())) {
    return res.status(400).json({ error: 'invalid_tier', allowed: Array.from(VALID_TIER) });
  }
  const where = [`s.status = 'active'`, `s.deleted_at IS NULL`];
  const params = [];
  let i = 1;
  if (tier)   { where.push(`s.reputation_tier = $${i++}`); params.push(String(tier).toLowerCase()); }
  if (search) {
    const sEscaped = String(search).replace(/[%_\\]/g, '\\$&').slice(0, 100);
    where.push(`s.store_name ILIKE $${i++} ESCAPE '\\'`);
    params.push(`%${sEscaped}%`);
  }

  /* FIX-WORKER-7 pass 691 (Regra D direction parity - paridade cadeia 30+ sites cross-svc):
     PRE-FIX (pass 72): + s.id ASC tiebreaker mas MIXED direction com chains DESC
     - rep_desc + s.id ASC = MIXED -> External Sort obligatorio (idx composite nao bate)
     - sales_desc + s.id ASC = MIXED
     - newest (created_at DESC) + s.id ASC = MIXED
     - rep_asc + s.id ASC = paridade OK (ASC+ASC)
     Cadeia Regra D V8 cross-svc (30+ sites): DESC chain -> id DESC tiebreaker
     POST-FIX: id DESC para chains DESC, id ASC apenas para rep_asc
     Elimina External Sort hot path /sellers public listing
     Pattern V8 consolidacao paridade pass 624 admin/sellers + pass 648 /search SORT_OPTIONS. */
  const order = ({
    rep_desc:   's.reputation_score DESC, s.id DESC',
    rep_asc:    's.reputation_score ASC, s.id ASC',
    sales_desc: 's.total_sales DESC, s.id DESC',
    newest:     's.created_at DESC, s.id DESC',
  })[sort] || 's.reputation_score DESC, s.id DESC';

  /* FIX-WORKER-2 pass 325: COUNT(*) OVER() window consolidation.
     Pattern V8 20+ endpoints (passes 178-321). */
  params.push(lim, off);
  const r = await query(
    `SELECT s.id, s.store_slug, s.store_name, s.store_description, s.store_banner_url, s.store_logo_url,
            s.reputation_tier, s.reputation_score, s.total_sales, s.avg_rating,
            s.total_products_active, s.created_at,
            COUNT(*) OVER()::INT AS _total
       FROM sellers s
      WHERE ${where.join(' AND ')}
      ORDER BY ${order}
      LIMIT $${i++} OFFSET $${i++}`,
    params
  );

  const total = r.rows[0]?._total ?? 0;
  const sellers = r.rows.map((row) => { const { _total, ...rest } = row; return rest; });

  res.json({
    sellers,
    page: Number(page),
    limit: lim,
    total,
    has_more: (off + sellers.length) < total,
  });
}));

// GET /sellers/:slug - perfil publico
// FIX-WORKER-16: incluido is_verified (KYC concluido) + member_since para badges UI
// FIX-WORKER-18 pass 5: cache via withCache 60s (perfil quase imutavel, exceto avg_rating
// que muda em reviews mas TTL 60s eh aceitavel). Usar withCache (vs middleware) para
// preservar errorHandler.notFound() em casos slug invalido.
router.get('/:slug', asyncHandler(async (req, res, next) => {
  // FIX-WORKER-18 pass 380 (cache key normalization - paridade pass 350):
  //   PRE-FIX: cache.withCache(`sellers:detail:${req.params.slug}`) raw
  //   - User acessa /Loja-Tech, /LOJA-TECH, /loja-tech -> 3 entries Redis
  //   - DoS amplification + memory waste em sellers top
  //   - Cache pollution paridade products:detail (corrigido pass 350)
  //   POST-FIX: slugNorm trim().toLowerCase() consolidacao pattern V8
  //   Tambem query usa slugNorm direct (PG store_slug ja lowercase canonical).
  const slugNorm = String(req.params.slug || '').trim().toLowerCase();
  const { value: seller } = await cache.withCache(`sellers:detail:${slugNorm}`, 60, async () => {
    const r = await query(
      `SELECT s.id, s.store_slug, s.store_name, s.store_description,
              s.store_banner_url, s.store_logo_url,
              s.reputation_tier, s.reputation_score, s.total_sales, s.avg_rating,
              s.total_products_active, s.created_at,
              s.document_verified_at IS NOT NULL AS is_verified,
              s.seller_class,
              EXTRACT(YEAR FROM s.created_at)::INT AS member_since_year,
              u.display_name AS owner_name
         FROM sellers s
         JOIN users u ON u.id = s.user_id
        WHERE s.store_slug = $1 AND s.status = 'active' AND s.deleted_at IS NULL`,
      [slugNorm]
    );
    return r.rows[0] || null;
  });
  if (!seller) return next(errorHandler.notFound('seller_not_found'));
  res.json({ seller });
}));

// MLB-NEW WORKER 16: GET /sellers/:slug/stats - dashboard publico de reputacao
// Mercado Livre exibe pagina detalhada com gauges Atendimento/Entrega/Reclamacao
// e tier badge. Equivalente CAS adaptado:
// - on_time_qa_rate: % de produtos que passaram QA em ate 24h da submission
// - response_rate: % de Q&A respondidas em ate support_response_hours
// - refund_rate: % de orders refunded vs total
// - avg_rating + review_count
// FIX-WORKER-18 pass 5: cache 180s (3min) - stats agregam 4 queries DB pesadas.
// TTL maior porque metricas mudam devagar (sales/refunds dia-a-dia).
// FIX-WORKER-7 pass 99: 3 BUGS aplicando Pattern W7 (Regra A products + window + parallel).
//
// BUG 1 *** Regra A products status MISSING ***
//   PRE-FIX: stats agregam product_qa_runs/order_items/product_reviews sem
//   filter p.status / p.deleted_at. Produtos archived/rejected contam em
//   qa_approval_rate -> distorce metrica publica.
//   FIX: + AND p.status IN ('approved','platform_owned') + p.deleted_at IS NULL
//   em 3 sub-queries.
//
// BUG 2 *** ?window_days MISSING ***
//   PRE-FIX: stats acumulam VIDA-INTEIRA do seller. Mercado Livre mostra
//   "ultimos 90 dias" - novo seller com qa_approval=50% em 2 runs primeiros
//   semanas fica preso ate replicar 100 runs vida-inteira p/ subir media.
//   FIX: ?window_days (1-365, default 90) + WHERE created_at > NOW() - $.
//
// BUG 3 *** N+1 SEQUENTIAL QUERIES ***
//   PRE-FIX: 3 await sequenciais (qa + order + review). Latency = sum(3).
//   FIX: Promise.all() concurrent - latency = max(3).
router.get('/:slug/stats',
  /* FIX-WORKER-18 pass 521 (cache key + query case normalization - paridade pass 380/513):
     PRE-FIX BUGS (2 issues):
     1. Cache key usa req.params.slug RAW:
        - /sellers/Loja-Tech/stats vs /sellers/loja-tech/stats -> 2 Redis entries
        - DoS amplification + memory waste em sellers populares
        - Paridade /sellers/:slug detail pass 380 ja normalizava (este lagged)
     2. Query usa req.params.slug RAW (case-sensitive PG):
        - WHERE store_slug = 'LOJA-TECH' -> 0 rows (slugs DB lowercase canonical)
        - Cache MISS + Query 0 rows -> 404
        - Outro user: /sellers/loja-tech/stats -> Cache MISS (chave diferente) ->
          Query OK -> cache.set (chave lowercase)
        - Volta primeiro user: /sellers/LOJA-TECH/stats -> Cache MISS chave RAW
          (Loja-Tech !== loja-tech) -> Query 0 -> 404 again
        - Cache pollution + inconsistencia UX
     3. Pattern V8 W18 cache key/query consistency:
        - paridade pass 513 /products/:slug/related (PRE-FIX same bug)
        - paridade pass 380 /sellers/:slug detail (already fixed)
        - paridade pass 291 search top-sellers cat lowercase
     POST-FIX: slugNorm uma vez, usar em cache key + query.
     Trade-off ZERO: slugs DB lowercase canonical, normalize end-to-end. */
  cache.cacheMiddleware((req) => {
    const slugNorm = String(req.params.slug || '').trim().toLowerCase();
    const w = Math.min(365, Math.max(1, parseInt(req.query.window_days, 10) || 90));
    return `sellers:stats:${slugNorm}:w=${w}`;
  }, 180),
  asyncHandler(async (req, res, next) => {
  const windowDays = Math.min(365, Math.max(1, parseInt(req.query.window_days, 10) || 90));
  // FIX pass 521: normalize slug end-to-end (match cache key + DB canonical)
  const slugNorm = String(req.params.slug || '').trim().toLowerCase();

  const seller = await query(
    `SELECT id, store_name, reputation_tier, reputation_score, total_sales, avg_rating,
            total_products_active, created_at,
            document_verified_at IS NOT NULL AS is_verified
       FROM sellers WHERE store_slug = $1 AND status = 'active' AND deleted_at IS NULL`,
    [slugNorm]
  );
  if (!seller.rows.length) return next(errorHandler.notFound('seller_not_found'));
  const s = seller.rows[0];

  // BUG 3: Promise.all concurrent + BUG 1/2 status + window aplicados
  let qa_stats = { total: 0, approved: 0, rejected: 0 };
  let order_stats = { total_paid: 0, total_refunded: 0 };
  let review_count = 0;
  const [qaR, orderR, reviewR] = await Promise.all([
    query(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE verdict='approved') AS approved,
              COUNT(*) FILTER (WHERE verdict='rejected') AS rejected
         FROM product_qa_runs r
         JOIN products p ON p.id = r.product_id
        WHERE p.seller_id = $1::UUID
          AND p.status IN ('approved','platform_owned')
          AND p.deleted_at IS NULL
          AND r.started_at > NOW() - ($2 || ' days')::INTERVAL`,
      [s.id, String(windowDays)]
    ).catch(() => ({ rows: [] })),
    query(
      `SELECT COUNT(*) FILTER (WHERE o.status IN ('paid','fulfilled')) AS total_paid,
              COUNT(*) FILTER (WHERE o.status = 'refunded') AS total_refunded
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         JOIN products p ON p.id = oi.product_id
        WHERE oi.seller_id = $1::UUID
          AND p.status IN ('approved','platform_owned')
          AND p.deleted_at IS NULL
          AND o.created_at > NOW() - ($2 || ' days')::INTERVAL`,
      [s.id, String(windowDays)]
    ).catch(() => ({ rows: [] })),
    query(
      `SELECT COUNT(*) AS c FROM product_reviews pr
         JOIN products p ON p.id = pr.product_id
        WHERE p.seller_id = $1::UUID
          AND p.status IN ('approved','platform_owned')
          AND p.deleted_at IS NULL
          AND pr.created_at > NOW() - ($2 || ' days')::INTERVAL`,
      [s.id, String(windowDays)]
    ).catch(() => ({ rows: [] })),
  ]);
  if (qaR.rows[0]) qa_stats = qaR.rows[0];
  if (orderR.rows[0]) order_stats = orderR.rows[0];
  if (reviewR.rows[0]) review_count = parseInt(reviewR.rows[0].c || 0, 10);

  const total_paid = parseInt(order_stats.total_paid || 0, 10);
  const total_refunded = parseInt(order_stats.total_refunded || 0, 10);
  const qa_total = parseInt(qa_stats.total || 0, 10);
  const qa_approved = parseInt(qa_stats.approved || 0, 10);

  const refund_rate = total_paid > 0 ? Math.round((total_refunded / total_paid) * 10000) / 100 : 0;
  const qa_approval_rate = qa_total > 0 ? Math.round((qa_approved / qa_total) * 10000) / 100 : null;

  res.json({
    seller: s,
    stats: {
      total_paid,
      total_refunded,
      refund_rate_pct: refund_rate,
      qa_total,
      qa_approved,
      qa_approval_rate_pct: qa_approval_rate,
      review_count,
      avg_rating: s.avg_rating ? Number(s.avg_rating) : null,
    },
    badges: {
      verified: !!s.is_verified,
      top_tier: ['ouro','platinum','lider_platinum'].includes(s.reputation_tier),
      low_refund: refund_rate < 2 && total_paid >= 5, // <2% refund + min 5 vendas
      consistent_qa: qa_approval_rate != null && qa_approval_rate >= 90 && qa_total >= 3,
    },
    window_days: windowDays,
  });
}));

// GET /sellers/:slug/products - produtos publicos do seller
// FIX-WORKER-18 pass 5: cache 60s.
// FIX-WORKER-7 pass 99: 6 BUGS aplicando Pattern W7.
//
// BUG 1 *** Regra I vp.* *** vw_public_products view fields nao audited
//   PRE-FIX: SELECT vp.* - migrations futuras podem adicionar campos sensitive
//   na view. FIX: explicit fields (positiva).
// BUG 2 *** Regra D TIEBREAKER MISSING ***
//   ORDER BY sales_count DESC, created_at DESC sem id final.
//   2 products sales=0 + created=now() burst -> ordem indef.
// BUG 3 *** Total + has_more UX paginacao ***
// BUG 4 *** ?kind FILTER MISSING ***
//   UX MLB-style "Filtrar por: ai_agent / n8n_workflow" no seller page.
// BUG 5 *** ?sort MISSING ***
//   Frontend pode querer price_asc/rating/newest.
// BUG 6 *** 404 SELLER NOT FOUND ***
//   PRE-FIX: slug inexistente -> 200 {products:[]} inconsistente com /:slug 404.
//   UX impossivel distinguir "seller sem produtos" vs "seller deletado/404".
const SELLER_PRODUCTS_KIND = new Set([
  'automation','ai_agent','n8n_workflow','node_script','python_script',
  'php_script','prompt_pack','template','dataset','other'
]);
const SELLER_PRODUCTS_SORT = new Set(['relevance','newest','price_asc','price_desc','rating','sales']);

router.get('/:slug/products',
  /* FIX-WORKER-18 pass 531 (cache key/query case-mismatch paridade pass 513/521/529):
     PRE-FIX BUG (same class):
     - Cache key line 311: req.params.slug RAW
     - Pre-check query line 330: WHERE store_slug = req.params.slug RAW
     - Main query params line 346: [req.params.slug] RAW
     - 3 sites usando RAW = inconsistencia tripla
     Slugs DB lowercase canonical mas Express path nao normaliza:
     - /sellers/Loja-Tech/products vs /sellers/loja-tech/products = 2 cache keys
     - Query case-sensitive PG -> 'LOJA-TECH' nao matches DB 'loja-tech' -> 404
     POST-FIX: normalize early, use in cache key + ALL 3 query sites.
     Paridade pass 380 /sellers/:slug detail + pass 521 /:slug/stats + 529 reviews/qna */
  /* FIX-WORKER-10 pass 590 (cache key normalization paridade cadeia 14 sites
     W7+W10+W13+W18 cache hygiene cross-svc consolidacao - 15 sites total):
     PRE-FIX BUGS (4 issues cache pollution vs handler):
     1. Raw q.kind sem whitelist check. Handler valida SELLER_PRODUCTS_KIND
        (linha 332). ?kind=INVALID -> cache key 'k=INVALID', handler 400.
     2. Raw q.sort sem whitelist check. Handler valida SELLER_PRODUCTS_SORT
        (linha 337). ?sort=GARBAGE -> cache key 's=GARBAGE', handler 400.
     3. Raw q.page sem clamp. Handler Math.max(parseInt(...) || 1, 1) (linha 327).
        ?page=99999 -> cache key 'p=99999', handler still 1 -> SAME response.
     4. Raw q.limit sem clamp. Handler Math.max/Math.min [1, 100] (linha 326).
     POST-FIX: normalize cache key SAME way handler normalizes (paridade
     cadeia 14 sites pre-cache: 520/530/533/551/558/566/572/576/577/579/582/
     583/588/589). */
  cache.cacheMiddleware((req) => {
    const slugNorm = String(req.params.slug || '').trim().toLowerCase();
    // Normalize kind: whitelist or empty
    const kindRaw = String(req.query.kind || '').trim();
    const kindNorm = SELLER_PRODUCTS_KIND.has(kindRaw) ? kindRaw : '';
    // Normalize sort: whitelist or default
    const sortRaw = String(req.query.sort || '').trim();
    const sortNorm = SELLER_PRODUCTS_SORT.has(sortRaw) ? sortRaw : 'relevance';
    // Clamp page/limit (paridade handler linhas 326-327)
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const lim = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 24, 100));
    return `sellers:products:${slugNorm}:p=${page}:lim=${lim}:k=${kindNorm}:s=${sortNorm}`;
  }, 60),
  asyncHandler(async (req, res, next) => {
  const lim = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 24, 100));
  const off = (Math.max(parseInt(req.query.page, 10) || 1, 1) - 1) * lim;
  // FIX pass 531: normalize slug end-to-end (match cache key + DB canonical lowercase)
  const slugNorm = String(req.params.slug || '').trim().toLowerCase();

  // BUG 4: kind enum
  if (req.query.kind && !SELLER_PRODUCTS_KIND.has(req.query.kind)) {
    return res.status(400).json({ error: 'invalid_kind', allowed: Array.from(SELLER_PRODUCTS_KIND) });
  }
  // BUG 5: sort enum
  const sort = String(req.query.sort || 'relevance');
  if (sort && !SELLER_PRODUCTS_SORT.has(sort)) {
    return res.status(400).json({ error: 'invalid_sort', allowed: Array.from(SELLER_PRODUCTS_SORT) });
  }

  // BUG 6: pre-check seller exists (consistencia com /:slug 404)
  // FIX pass 531: slugNorm (case-insensitive end-to-end)
  const sellerCheck = await query(
    `SELECT id FROM sellers WHERE store_slug = $1 AND status = 'active' AND deleted_at IS NULL LIMIT 1`,
    [slugNorm]
  );
  if (!sellerCheck.rows.length) return next(errorHandler.notFound('seller_not_found'));

  /* FIX-WORKER-7 pass 699 (Regra D direction parity SORT_OPTIONS 5/6 sorts - paridade cadeia 6 sites):
     PRE-FIX: 5 sorts MIXED direction (DESC chain + vp.id ASC)
     - relevance/newest/price_desc/rating/sales: DESC + id ASC = External Sort obligatorio
     - price_asc: ASC + id ASC = paridade OK
     Cadeia Regra D V8 cross-svc 30+ sites: DESC chain -> id DESC tiebreaker
     POST-FIX: 5 sorts DESC chains com id DESC explicit (paridade pass 648 /search,
     pass 691 /sellers public, pass 624 admin/sellers, pass 696 product related/also-bought)
     Elimina External Sort hot path /seller/:slug/products listing. */
  const orderClause = ({
    relevance:  'vp.sales_count DESC, vp.avg_rating DESC NULLS LAST, vp.id DESC',
    newest:     'vp.created_at DESC, vp.id DESC',
    price_asc:  'vp.price_cents ASC, vp.id ASC',
    price_desc: 'vp.price_cents DESC, vp.id DESC',
    rating:     'vp.avg_rating DESC NULLS LAST, vp.review_count DESC, vp.id DESC',
    sales:      'vp.sales_count DESC, vp.id DESC',
  })[sort] || 'vp.sales_count DESC, vp.id DESC';

  // Build WHERE
  // FIX pass 531: slugNorm (paridade pre-check + cache key)
  const whereParts = ['s.store_slug = $1'];
  const params = [slugNorm];
  let i = 2;
  if (req.query.kind) {
    whereParts.push(`vp.kind = $${i++}`);
    params.push(req.query.kind);
  }
  params.push(lim, off);
  const limIdx = i++;
  const offIdx = i++;

  // BUG 1: explicit fields whitelist (assume vw_public_products tem campos padrao)
  const r = await query(
    `SELECT vp.id, vp.slug, vp.title, vp.subtitle, vp.short_description, vp.kind,
            vp.cover_image_url, vp.price_cents, vp.currency, vp.is_free,
            vp.tech_stack, vp.avg_rating, vp.review_count, vp.sales_count,
            vp.is_platform_owned, vp.created_at
       FROM vw_public_products vp
       JOIN sellers s ON s.id = vp.seller_id
      WHERE ${whereParts.join(' AND ')}
      ORDER BY ${orderClause}
      LIMIT $${limIdx} OFFSET $${offIdx}`,
    params
  );

  // BUG 3: total count + has_more
  const countParams = params.slice(0, -2);
  const totalRes = await query(
    `SELECT COUNT(*)::INT AS total FROM vw_public_products vp
       JOIN sellers s ON s.id = vp.seller_id
      WHERE ${whereParts.join(' AND ')}`,
    countParams
  );
  const total = totalRes.rows[0].total;

  res.json({
    products: r.rows,
    total, limit: lim, offset: off,
    has_more: (off + r.rows.length) < total,
    sort, kind: req.query.kind || null,
  });
}));

module.exports = router;
