'use strict';

const express = require('express');
const { z } = require('zod');
const { query, tx } = require('@cas/db-client');
const { jwt, asyncHandler, validate, errorHandler, logger } = require('@cas/shared');

const router = express.Router();
const log = logger.child({ svc: 'product-svc', mod: 'seller-mgmt' });
router.use(jwt.requireAuth({ roles: ['seller','admin'] }));

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

// GET /products/me - lista produtos do seller
router.get('/', asyncHandler(async (req, res) => {
  const r = await query(
    `SELECT p.id, p.slug, p.title, p.status, p.kind, p.price_cents, p.qa_verdict, p.qa_confidence_score,
            p.sales_count, p.avg_rating, p.review_count, p.created_at, p.published_at
       FROM products p
       JOIN sellers s ON s.id = p.seller_id
      WHERE s.user_id = $1 AND p.deleted_at IS NULL
      ORDER BY p.created_at DESC`, [req.user.sub]
  );
  res.json({ products: r.rows });
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
  const qaUrl = `http://127.0.0.1:${process.env.PORT_QA || 3013}/qa/run`;
  fetch(qaUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ product_id: r.rows[0].id, triggered_by: req.user.sub })
  }).catch((e) => log.warn({ err: e.message }, '[qa.dispatch_failed]'));

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
