'use strict';

const express = require('express');
const { z } = require('zod');
const { query, tx } = require('@cas/db-client');
const { jwt, asyncHandler, validate, errorHandler, logger, cache, rateLimiter } = require('@cas/shared');

// FIX-WORKER-7 pass 82: rate-limit anti-spam drafts.
// PRE-FIX: POST /products/me SEM rate-limit. Seller pwned/bot pode spawn
// drafts ilimitados:
//   - DoS QA queue (cron processa cada draft -> backlog)
//   - Storage waste (cada draft ocupa ~5KB + media references)
//   - Audit log spam
// FIX: 10 drafts/hr/seller (real users criam ~1-2 drafts/dia)
const draftCreateLimiter = rateLimiter.createLimiter({
  windowMs: 60 * 60 * 1000, max: 10,
  message: 'Muitos produtos criados recentemente. Aguarde 1 hora.',
});

// FIX-WORKER-7 pass 82: cap absoluto produtos ativos por seller (Regra L).
// PRE-FIX: seller pode ter MILHARES produtos drafts (cumulative spam).
// Mesmo com rate-limit 10/hr -> 240/dia -> 7200/mes = inviavel manualmente
// MAS script ataque sustentado quebra QA queue.
// FIX: hard cap 500 products NOT archived/deleted por seller.
const MAX_PRODUCTS_PER_SELLER = parseInt(process.env.MAX_PRODUCTS_PER_SELLER || '500', 10);

const router = express.Router();
const log = logger.child({ svc: 'product-svc', mod: 'seller-mgmt' });
router.use(jwt.requireAuth({ roles: ['seller','admin'] }));

// FIX-WORKER-18: helper de invalidacao reutilizado em todas mutations
// FIX-WORKER-7 pass 5: agora aceita productId opcional para invalidar caches
// especificos por slug (detail/reviews/qna/related). Antes, PATCH em produto
// invalidava apenas patterns globais -> PDP detail mostrava versao antiga
// por 60s ate TTL natural expirar. Bug visivel quando seller edita preco/title
// e abre PDP -> ve dado stale.
async function invalidate(productId) {
  try {
    const tasks = [
      cache.del('products:list:*'),
      cache.del('products:related:*'),
      cache.del('search:facets:*'),
    ];
    if (productId) {
      // Lookup slug e invalida caches especificos do produto
      const r = await query('SELECT slug FROM products WHERE id = $1', [productId]);
      if (r.rows.length) {
        const slug = r.rows[0].slug;
        tasks.push(
          cache.del(`products:detail:${slug}`),
          cache.del(`products:reviews:${slug}:*`),
          cache.del(`products:qna:${slug}`)
        );
      }
    }
    await Promise.all(tasks);
  } catch (e) { log.warn({ err: e.message }, '[cache.invalidate_fail]'); }
}

const draftSchema = z.object({
  category_id: z.string().uuid(),
  kind: z.enum(['automation','ai_agent','n8n_workflow','node_script','python_script','php_script','prompt_pack','template','dataset','other']),
  title: z.string().min(5).max(200),
  subtitle: z.string().max(300).optional(),
  description: z.string().min(50),
  short_description: z.string().max(500).optional(),
  price_cents: z.number().int().min(0),
  currency: z.string().length(3).default('BRL'),
  license_kind: z.enum(['single_use','unlimited','subscription_monthly','subscription_yearly']).default('single_use'),
  tech_stack: z.array(z.string()).optional(),
  requirements: z.string().optional(),
  install_instructions: z.string().optional(),
  api_keys_required: z.array(z.string()).optional(),
  estimated_install_min: z.number().int().nonnegative().optional(),
  cover_image_url: z.string().url().optional(),
  attributes: z.record(z.any()).optional(),
  meta_keywords: z.array(z.string()).optional(),
});

function slugify(text) {
  return text.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 180);
}

// GET /products/me - lista produtos do seller (e admin com ?seller_id filter)
// FIX-WORKER-7 pass 69: 7 BUGS aplicando Pattern W7.
//
// BUG 1 *** Regra D TIEBREAKER MISSING *** ORDER BY created_at DESC nao determ
//   2 products created_at identicos (bulk import seller) -> ordem indefinida.
//   FIX: + p.id DESC tiebreaker.
//
// BUG 2 *** Regra E NO LIMIT *** response unbounded
//   Seller heavy (500+ products) -> response 500 rows ~250KB transferred.
//   FIX: ?limit (1-200, default 50) + ?offset.
//
// BUG 3 *** ?status FILTER MISSING ***
//   Seller quer triar: ver só "qa_pending" (rascunhos), "rejected" (refazer),
//   "approved" (publicados). Sem filter -> frontend filter post-fetch = waste.
//   FIX: ?status enum whitelist (draft|qa_pending|qa_running|approved|rejected|archived).
//
// BUG 4 *** ?kind FILTER MISSING ***
//   Seller multi-kind quer triar por tipo (ai_agent vs n8n_workflow).
//   FIX: ?kind enum (matches draftSchema.kind).
//
// BUG 5 *** ADMIN BYPASS *** roles ['seller','admin'] mas JOIN sellers
//   PRE-FIX: admin SEM entry em sellers -> JOIN retorna 0 rows.
//   Endpoint inutil para admin investigar produtos cross-seller.
//   Pattern admin bypass cross-svc estabelecido pass 36/56/67.
//   FIX: isAdmin path com opcional ?seller_id filter (sem ownership).
//
// BUG 6 *** TOTAL + has_more UX ***
//   Frontend "Carregar mais" nao sabe quando "no more".
//   FIX: COUNT + has_more flag.
//
// BUG 7 *** Regra I price_cents currency missing ***
//   PRE-FIX: response sem currency - frontend assume BRL hardcoded.
//   FIX: + p.currency (consistencia multi-currency futuro).
const SELLER_PRODUCT_STATUS = new Set([
  'draft','qa_pending','qa_running','approved','rejected','archived','platform_owned'
]);
const SELLER_PRODUCT_KIND = new Set([
  'automation','ai_agent','n8n_workflow','node_script','python_script',
  'php_script','prompt_pack','template','dataset','other'
]);
const SELLER_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/', asyncHandler(async (req, res) => {
  const isAdmin = req.user && req.user.role === 'admin';
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

  // Status filter optional
  const statusFilter = req.query.status ? String(req.query.status) : null;
  if (statusFilter && !SELLER_PRODUCT_STATUS.has(statusFilter)) {
    return res.status(400).json({ error: 'invalid_status', allowed: Array.from(SELLER_PRODUCT_STATUS) });
  }
  // Kind filter optional
  const kindFilter = req.query.kind ? String(req.query.kind) : null;
  if (kindFilter && !SELLER_PRODUCT_KIND.has(kindFilter)) {
    return res.status(400).json({ error: 'invalid_kind', allowed: Array.from(SELLER_PRODUCT_KIND) });
  }

  // Build WHERE
  const whereParts = ['p.deleted_at IS NULL'];
  const params = [];
  let i = 1;

  if (isAdmin) {
    // Admin path: opcional ?seller_id filter (sem ownership via JOIN sellers)
    const sellerIdFilter = req.query.seller_id ? String(req.query.seller_id) : null;
    if (sellerIdFilter) {
      if (!SELLER_UUID_RE.test(sellerIdFilter)) {
        return res.status(400).json({ error: 'invalid_seller_id' });
      }
      whereParts.push(`p.seller_id = $${i++}::UUID`);
      params.push(sellerIdFilter);
    }
    // Sem seller_id: admin vê TODOS products (uso debug/investigacao)
  } else {
    // Seller path: ownership via JOIN sellers
    whereParts.push(`s.user_id = $${i++}::UUID`);
    params.push(req.user.sub);
  }

  if (statusFilter) {
    whereParts.push(`p.status = $${i++}`);
    params.push(statusFilter);
  }
  if (kindFilter) {
    whereParts.push(`p.kind = $${i++}`);
    params.push(kindFilter);
  }

  params.push(limit, offset);
  const limIdx = i++;
  const offIdx = i++;

  const joinClause = isAdmin
    ? 'LEFT JOIN sellers s ON s.id = p.seller_id'  // admin: LEFT JOIN (platform_owned products sem seller)
    : 'JOIN sellers s ON s.id = p.seller_id';      // seller: INNER JOIN (ownership)

  const r = await query(
    `SELECT p.id, p.slug, p.title, p.status, p.kind, p.price_cents, p.currency,
            p.qa_verdict, p.qa_confidence_score,
            p.sales_count, p.avg_rating, p.review_count,
            p.created_at, p.published_at
       FROM products p
       ${joinClause}
      WHERE ${whereParts.join(' AND ')}
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT $${limIdx} OFFSET $${offIdx}`,
    params
  );

  // Total count
  const countParams = params.slice(0, -2);
  const totalRes = await query(
    `SELECT COUNT(*)::INT AS total FROM products p ${joinClause} WHERE ${whereParts.join(' AND ')}`,
    countParams
  );
  const total = totalRes.rows[0].total;

  res.json({
    products: r.rows,
    total,
    limit,
    offset,
    has_more: (offset + r.rows.length) < total,
    filters: {
      status: statusFilter,
      kind: kindFilter,
      seller_id: isAdmin && req.query.seller_id ? req.query.seller_id : null,
    },
    is_admin_view: isAdmin,
  });
}));

// POST /products/me - cria draft
// FIX-WORKER-7 pass 82: 4 BUGS aplicando Pattern W7 (Regras L+K + race + rate-limit).
//
// BUG 1 *** Regra L resource cap MISSING *** seller cria drafts ilimitados
//   PRE-FIX: zero check quantidade. Bot pwned spawn 10.000 drafts -> DoS:
//   - QA queue cron processa cada -> backlog gigante
//   - Storage 50MB+ apenas references inativas
//   - Audit log explosion
//   FIX: MAX_PRODUCTS_PER_SELLER cap (default 500, env-configurable).
//
// BUG 2 *** SLUG COLLISION RACE *** SELECT-THEN-INSERT
//   PRE-FIX: linha 208-209 SELECT slug + INSERT separados (TOCTOU).
//   2 sellers slugify mesmo title simultaneo -> ambos passam SELECT -> ambos
//   INSERT -> SECOND falha unique constraint -> 500 leak.
//   FIX: try INSERT + ON CONFLICT (slug) DO NOTHING + retry com suffix randomico.
//
// BUG 3 *** Regra K tx() ATOMICITY *** seller_active check + INSERT non-atomic
//   PRE-FIX: SELECT seller status + INSERT em transactions diferentes.
//   Entre as 2 queries, admin pode suspender seller -> INSERT cria draft
//   em seller suspended (compliance break).
//   FIX: tx() wrap + FOR UPDATE em sellers.
//
// BUG 4 *** RATE-LIMIT MISSING *** ja addressed acima via draftCreateLimiter.
router.post('/',
  draftCreateLimiter,
  validate({ body: draftSchema }),
  asyncHandler(async (req, res, next) => {
    const b = req.body;
    let outcome;
    let product;

    await tx(async (c) => {
      // Regra K: SELECT FOR UPDATE seller (anti-race admin suspend during INSERT)
      const s = await c.query(
        `SELECT id FROM sellers WHERE user_id = $1 AND status = 'active' FOR UPDATE`,
        [req.user.sub]
      );
      if (!s.rows.length) { outcome = { error: 'seller_not_active' }; return; }
      const sellerId = s.rows[0].id;

      // BUG 1 Regra L: cap produtos ativos por seller
      const countRow = await c.query(
        `SELECT COUNT(*)::INT AS n FROM products
          WHERE seller_id = $1
            AND status NOT IN ('archived')
            AND deleted_at IS NULL`,
        [sellerId]
      );
      if (countRow.rows[0].n >= MAX_PRODUCTS_PER_SELLER) {
        outcome = {
          error: 'max_products_exceeded',
          current_count: countRow.rows[0].n,
          max_allowed: MAX_PRODUCTS_PER_SELLER,
        };
        return;
      }

      // BUG 2: slug com retry inteligente via ON CONFLICT
      let slug = slugify(b.title);
      // Tenta INSERT - se conflict, gera novo slug + retry
      let attempt = 0;
      const MAX_ATTEMPTS = 5;
      while (attempt < MAX_ATTEMPTS) {
        const ins = await c.query(
          `INSERT INTO products
            (seller_id, category_id, kind, status, slug, title, subtitle, description, short_description,
             price_cents, currency, license_kind, tech_stack, requirements, install_instructions,
             api_keys_required, estimated_install_min, cover_image_url, attributes, meta_keywords)
           VALUES ($1,$2,$3,'draft',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::JSONB,$19)
           ON CONFLICT (slug) DO NOTHING
           RETURNING id, slug, status, created_at`,
          [sellerId, b.category_id, b.kind, slug, b.title, b.subtitle || null, b.description, b.short_description || null,
           b.price_cents, b.currency, b.license_kind, b.tech_stack || null, b.requirements || null,
           b.install_instructions || null, b.api_keys_required || null, b.estimated_install_min || null,
           b.cover_image_url || null, JSON.stringify(b.attributes || {}), b.meta_keywords || null]
        );
        if (ins.rows.length) {
          product = ins.rows[0];
          break;
        }
        // Conflict - tenta novo slug com sufixo randomico
        slug = slugify(b.title) + '-' + Math.random().toString(36).slice(2, 7);
        attempt++;
      }
      if (!product) {
        outcome = { error: 'slug_collision_exhausted' };
        return;
      }
    });

    if (outcome?.error === 'seller_not_active') return next(errorHandler.forbidden('seller_not_active'));
    if (outcome?.error === 'max_products_exceeded') {
      return res.status(429).json({
        error: 'max_products_exceeded',
        message: `Limite de ${outcome.max_allowed} produtos ativos por seller atingido. Arquive produtos antigos.`,
        current_count: outcome.current_count,
        max_allowed: outcome.max_allowed,
      });
    }
    if (outcome?.error === 'slug_collision_exhausted') {
      return next(errorHandler.badRequest('slug_collision', 'Nao foi possivel gerar slug unico. Tente outro titulo.'));
    }

    log.info({ product_id: product.id, seller_user: req.user.sub }, '[product.draft]');
    await invalidate();
    res.status(201).json({ product });
  })
);

// PATCH /products/me/:id - edit draft/rejected product
// FIX-WORKER-7 pass 83: 6 BUGS aplicando Pattern W7 (UUID+Regra K+P+validation).
//
// BUG 1 *** UUID VALIDATE MISSING *** PG 22P02 -> 500 leak
//   PRE-FIX: req.params.id sem validate antes query.
//   PATCH /products/me/admin (slug invalido como UUID) -> PG cast error 500.
//   FIX: PRODUCT_UUID_RE.test() upfront.
//
// BUG 2 *** Regra K tx() ATOMICITY MISSING ***
//   PRE-FIX: SELECT ownership + UPDATE em statements separados (TOCTOU race):
//   - 2 PATCHs simultaneos do mesmo seller = lost update (last write wins)
//   - PATCH + admin force-approve simultaneo = status race
//   - PATCH + seller mass-update title -> slug stale cache
//   FIX: tx() wrap + SELECT FOR UPDATE em products.
//
// BUG 3 *** FIELD VALIDATION MISSING *** raw values -> PG errors
//   PRE-FIX: vals.push(req.body[k]) sem type/range check:
//   - price_cents = 'abc' -> PG INTEGER cast 22P02 -> 500
//   - price_cents = -100 -> aceita preco negativo (UX FAIL)
//   - category_id = 'not-a-uuid' -> PG UUID cast 22P02 -> 500
//   - estimated_install_min = -50 -> aceita tempo negativo
//   FIX: Zod patchSchema (subset draftSchema, todos optional).
//
// BUG 4 *** Regra P AUDIT LOG MISSING ***
//   Mutation critica (price/title change) sem trail. Compliance gap.
//   PATCH price 100 -> 0 (fraude seller pwned) sem rastro.
//   FIX: INSERT audit_log atomic dentro tx() (severity warn p/ price changes).
//
// BUG 5 *** noop EARLY RETURN BEFORE OWNERSHIP CHECK ***
//   PRE-FIX: ownership query rodava ANTES do empty-body check.
//   Wasteful DB hit p/ payload vazio. Sem leak mas inefficient.
//   FIX: empty check upfront -> 400 no_fields_to_update.
//
// BUG 6 *** UPDATE retorna 0 rows silencioso ***
//   PRE-FIX: WHERE p.id=$N (sem ownership re-check). Em race extremo,
//   product pode mudar status entre SELECT e UPDATE -> rowcount=0 mas
//   response 200 ok (UX confuso).
//   FIX: WHERE incluindo status IN ('draft','rejected') + check rowcount.
const PATCH_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const patchSchema = z.object({
  title: z.string().min(5).max(200).optional(),
  subtitle: z.string().max(300).optional(),
  description: z.string().min(50).optional(),
  short_description: z.string().max(500).optional(),
  price_cents: z.number().int().min(0).max(100000000).optional(),  // max R$ 1M
  tech_stack: z.array(z.string()).optional(),
  requirements: z.string().optional(),
  install_instructions: z.string().optional(),
  api_keys_required: z.array(z.string()).optional(),
  estimated_install_min: z.number().int().nonnegative().max(10080).optional(),  // max 1 week
  cover_image_url: z.string().url().optional(),
  category_id: z.string().uuid().optional(),
  attributes: z.record(z.any()).optional(),
  meta_keywords: z.array(z.string()).optional(),
});

router.patch('/:id', validate({ body: patchSchema }), asyncHandler(async (req, res, next) => {
  // BUG 1: UUID validate upfront
  if (!PATCH_UUID_RE.test(req.params.id)) {
    return next(errorHandler.notFound('product_not_editable'));
  }

  // BUG 5: empty body check ANTES de qualquer DB hit
  const allowed = ['title','subtitle','description','short_description','price_cents','tech_stack',
    'requirements','install_instructions','api_keys_required','estimated_install_min',
    'cover_image_url','category_id','attributes','meta_keywords'];
  const fieldsProvided = allowed.filter((k) => req.body[k] !== undefined);
  if (!fieldsProvided.length) {
    return res.status(400).json({ error: 'no_fields_to_update', message: 'Nenhum campo valido fornecido.' });
  }

  let outcome;
  await tx(async (c) => {
    // BUG 2 Regra K: SELECT FOR UPDATE em products (anti-race)
    const owns = await c.query(
      `SELECT p.id, p.title, p.price_cents AS old_price, p.status
         FROM products p JOIN sellers s ON s.id = p.seller_id
        WHERE p.id = $1 AND s.user_id = $2 AND p.status IN ('draft','rejected')
        FOR UPDATE OF p`,
      [req.params.id, req.user.sub]
    );
    if (!owns.rows.length) { outcome = { error: 'not_editable' }; return; }
    const prevState = owns.rows[0];

    // Build SET dinamico
    const cols = []; const vals = []; let i = 1;
    for (const k of fieldsProvided) {
      cols.push(`${k} = $${i++}`);
      vals.push(k === 'attributes' ? JSON.stringify(req.body[k]) : req.body[k]);
    }
    vals.push(req.params.id);

    // BUG 6: UPDATE com re-check status (anti-race)
    const upd = await c.query(
      `UPDATE products SET ${cols.join(', ')}, updated_at = NOW()
        WHERE id = $${i} AND status IN ('draft','rejected')`,
      vals
    );
    if (upd.rowCount === 0) { outcome = { error: 'status_changed_during_update' }; return; }

    // BUG 4 Regra P: audit log atomic - severity=warn se preco mudou
    const priceChanged = req.body.price_cents !== undefined
      && req.body.price_cents !== prevState.old_price;
    await c.query(
      `INSERT INTO audit_log
        (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
       VALUES ($1, $2, 'product.patch', 'product', $3, $4, $5::JSONB)`,
      [req.user.sub, req.user.role, req.params.id,
       priceChanged ? 'warn' : 'info',
       JSON.stringify({
         fields: fieldsProvided,
         price_changed: priceChanged,
         old_price_cents: priceChanged ? prevState.old_price : null,
         new_price_cents: priceChanged ? req.body.price_cents : null,
         ip: req.ip,
       })]
    );

    outcome = { ok: true };
  });

  if (outcome?.error === 'not_editable') return next(errorHandler.notFound('product_not_editable'));
  if (outcome?.error === 'status_changed_during_update') {
    return res.status(409).json({
      error: 'status_changed',
      message: 'Status do produto mudou durante a edicao. Recarregue e tente novamente.',
    });
  }

  // FIX-WORKER-7 pass 5: passa productId para invalidate cache detail/reviews/qna por slug
  await invalidate(req.params.id);
  res.json({ ok: true });
}));

// POST /products/me/:id/submit - envia para QA
router.post('/:id/submit', asyncHandler(async (req, res, next) => {
  const r = await query(
    `UPDATE products p
        SET status = 'qa_pending', submitted_at = NOW(), updated_at = NOW()
       FROM sellers s
      WHERE p.id = $1 AND p.seller_id = s.id AND s.user_id = $2 AND p.status IN ('draft','rejected')
      RETURNING p.id, p.title`,
    [req.params.id, req.user.sub]
  );
  if (!r.rows.length) return next(errorHandler.badRequest('cannot_submit', 'Produto nao esta em draft/rejected'));

  // dispara webhook QA (assincrono, nao bloqueia)
  // FIX-WORKER-12 pass 2: usa service mesh URL + x-internal-token (qa-svc agora exige auth)
  const qaUrl = `${process.env.UPSTREAM_QA || `http://tasks.cas_qa-svc:${process.env.PORT_QA || 3013}`}/qa/run`;
  fetch(qaUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.QA_RUN_INTERNAL_TOKEN ? { 'x-internal-token': process.env.QA_RUN_INTERNAL_TOKEN } : {}),
    },
    body: JSON.stringify({ product_id: r.rows[0].id, triggered_by: req.user.sub })
  }).catch((e) => log.warn({ err: e.message }, '[qa.dispatch_failed]'));

  await invalidate(req.params.id);
  res.json({ ok: true, message: 'Produto enviado para QA' });
}));

// POST /products/me/:id/versions - publica nova versao (changelog)
router.post('/:id/versions',
  validate({ body: z.object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    changelog: z.string().min(5),
    breaking_changes: z.boolean().default(false),
    package_url: z.string().url().optional(),
    package_hash_sha256: z.string().length(64).optional(),
  })}),
  asyncHandler(async (req, res, next) => {
    const owns = await query(
      `SELECT p.id FROM products p JOIN sellers s ON s.id = p.seller_id
        WHERE p.id = $1 AND s.user_id = $2`, [req.params.id, req.user.sub]
    );
    if (!owns.rows.length) return next(errorHandler.notFound('not_found'));
    const r = await query(
      `INSERT INTO product_versions
        (product_id, version, changelog, breaking_changes, package_url, package_hash_sha256, qa_verdict)
       VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING *`,
      [req.params.id, req.body.version, req.body.changelog, req.body.breaking_changes,
       req.body.package_url || null, req.body.package_hash_sha256 || null]
    );

    // MLB-NEW: notifica subscribers (wishlist + buyers ja owners) sobre nova versao.
    // Mercado Livre style 'voltou para o estoque' adaptado para digital products.
    // Fan-out via INSERT em notifications - async, nao bloqueia response.
    try {
      const productInfo = await query(
        `SELECT title, slug FROM products WHERE id = $1`, [req.params.id]
      );
      const title = productInfo.rows[0]?.title || 'Produto';
      const slug  = productInfo.rows[0]?.slug || '';
      const ver   = req.body.version;
      const bcWarn = req.body.breaking_changes ? ' (BREAKING CHANGES - revise antes de atualizar)' : '';

      // Subscribers = wishlist + buyers (UNION distinct para evitar dupe)
      // Exclui o proprio seller (que esta publicando)
      // notifications.channel eh ENUM notification_channel - cast obrigatorio
      await query(
        `INSERT INTO notifications (user_id, channel, template_code, title, body, payload, priority)
         SELECT DISTINCT u.id, 'in_app'::notification_channel, 'product_new_version', $1::text, $2::text, $3::JSONB, 0
           FROM (
             SELECT user_id FROM product_wishlist WHERE product_id = $4::UUID
             UNION
             SELECT DISTINCT o.buyer_user_id AS user_id FROM order_items oi
               JOIN orders o ON o.id = oi.order_id
              WHERE oi.product_id = $4::UUID AND o.status IN ('paid','fulfilled')
           ) AS subs
           JOIN users u ON u.id = subs.user_id
          WHERE u.deleted_at IS NULL AND u.is_active = TRUE AND u.id != $5::UUID`,
        [
          `Nova versao v${ver}: ${title}`,
          `O produto "${title}" recebeu uma atualizacao v${ver}${bcWarn}.\nChangelog: ${req.body.changelog.slice(0, 500)}`,
          JSON.stringify({ product_id: req.params.id, slug, version: ver, breaking_changes: req.body.breaking_changes }),
          req.params.id,
          req.user.sub,
        ]
      );
    } catch (e) {
      // Nao bloqueia o create de version se notification falhar
      log.warn({ err: e.message, product_id: req.params.id }, '[version.notify_failed]');
    }

    res.status(201).json({ version: r.rows[0] });
  })
);

// POST /products/me/:id/qna/:qid/answer
router.post('/:id/qna/:qid/answer',
  validate({ body: z.object({ answer: z.string().min(1).max(5000) }) }),
  asyncHandler(async (req, res) => {
    await query(
      `UPDATE product_qna q
          SET answer = $1, answered_at = NOW(), answered_by_user_id = $2, updated_at = NOW()
         FROM products p, sellers s
        WHERE q.id = $3 AND q.product_id = p.id AND p.seller_id = s.id AND s.user_id = $2`,
      [req.body.answer, req.user.sub, req.params.qid]
    );
    res.json({ ok: true });
  })
);

module.exports = router;
