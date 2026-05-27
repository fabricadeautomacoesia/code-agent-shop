'use strict';

const express = require('express');
const { z } = require('zod');
const { query, tx } = require('@cas/db-client');
const { jwt, asyncHandler, validate, errorHandler, logger, cache } = require('@cas/shared');

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
router.post('/', validate({ body: draftSchema }), asyncHandler(async (req, res, next) => {
  const s = await query('SELECT id FROM sellers WHERE user_id = $1 AND status = $2', [req.user.sub, 'active']);
  if (!s.rows.length) return next(errorHandler.forbidden('seller_not_active'));

  let slug = slugify(req.body.title);
  // resolver colisao
  const exists = await query('SELECT 1 FROM products WHERE slug = $1', [slug]);
  if (exists.rows.length) slug = slug + '-' + Math.random().toString(36).slice(2, 7);

  const b = req.body;
  const r = await query(
    `INSERT INTO products
      (seller_id, category_id, kind, status, slug, title, subtitle, description, short_description,
       price_cents, currency, license_kind, tech_stack, requirements, install_instructions,
       api_keys_required, estimated_install_min, cover_image_url, attributes, meta_keywords)
     VALUES ($1,$2,$3,'draft',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::JSONB,$19)
     RETURNING id, slug, status, created_at`,
    [s.rows[0].id, b.category_id, b.kind, slug, b.title, b.subtitle || null, b.description, b.short_description || null,
     b.price_cents, b.currency, b.license_kind, b.tech_stack || null, b.requirements || null,
     b.install_instructions || null, b.api_keys_required || null, b.estimated_install_min || null,
     b.cover_image_url || null, JSON.stringify(b.attributes || {}), b.meta_keywords || null]
  );
  log.info({ product_id: r.rows[0].id, seller_user: req.user.sub }, '[product.draft]');
  await invalidate();
  res.status(201).json({ product: r.rows[0] });
}));

// PATCH /products/me/:id
router.patch('/:id', asyncHandler(async (req, res, next) => {
  const owns = await query(
    `SELECT p.id FROM products p JOIN sellers s ON s.id = p.seller_id
      WHERE p.id = $1 AND s.user_id = $2 AND p.status IN ('draft','rejected')`,
    [req.params.id, req.user.sub]
  );
  if (!owns.rows.length) return next(errorHandler.notFound('product_not_editable'));
  const allowed = ['title','subtitle','description','short_description','price_cents','tech_stack',
    'requirements','install_instructions','api_keys_required','estimated_install_min',
    'cover_image_url','category_id','attributes','meta_keywords'];
  const cols = []; const vals = []; let i = 1;
  for (const k of allowed) {
    if (req.body[k] !== undefined) {
      cols.push(`${k} = $${i++}`);
      vals.push(k === 'attributes' ? JSON.stringify(req.body[k]) : req.body[k]);
    }
  }
  if (!cols.length) return res.json({ ok: true, noop: true });
  vals.push(req.params.id);
  await query(`UPDATE products SET ${cols.join(', ')}, updated_at = NOW() WHERE id = $${i}`, vals);
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
