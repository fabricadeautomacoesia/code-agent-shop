'use strict';

const express = require('express');
const { z } = require('zod');
const { query, tx } = require('@cas/db-client');
const { jwt, asyncHandler, validate, errorHandler, logger, cache } = require('@cas/shared');

const router = express.Router();
const log = logger.child({ svc: 'product-svc', mod: 'admin' });
router.use(jwt.requireAuth({ roles: ['admin','staff'] }));

// FIX-WORKER-18: invalidacao de cache em mutations
// FIX-WORKER-7 pass 5: aceita productId para invalidacao especifica detail/reviews/qna
async function invalidateProductCache(productId) {
  try {
    const tasks = [
      cache.del('products:list:*'),
      cache.del('products:related:*'),
      cache.del('products:flash-promo:*'),
      cache.del('search:top-sellers:*'),
      cache.del('search:facets:*'),
    ];
    if (productId) {
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

// GET /products/admin/qa-queue
// FIX-WORKER-4 pass 14: enrich com last_run_verdict (W12 pass 7 timeouts).
// Antes: admin via "qa_pending" simples sem saber se foi timeout anterior.
// Agora: subquery do ultimo run revela 'timeout' (cron auto-cancel), 'error'
// (dispatch fail), 'rejected' (LLM rejeitou), etc.
// Usa idx_qa_runs_product_started (W14 pass 6) - 1 scan por product_id ordenado DESC.
router.get('/qa-queue', asyncHandler(async (req, res) => {
  const r = await query(
    `SELECT p.id, p.title, p.slug, p.status, p.qa_verdict, p.qa_confidence_score,
            p.submitted_at, s.store_name, u.email,
            (SELECT verdict FROM product_qa_runs r
               WHERE r.product_id = p.id
               ORDER BY r.started_at DESC LIMIT 1) AS last_run_verdict,
            (SELECT started_at FROM product_qa_runs r
               WHERE r.product_id = p.id
               ORDER BY r.started_at DESC LIMIT 1) AS last_run_started_at,
            (SELECT COUNT(*)::INT FROM product_qa_runs r
               WHERE r.product_id = p.id
                 AND r.verdict = 'timeout') AS timeout_count
       FROM products p
       LEFT JOIN sellers s ON s.id = p.seller_id
       LEFT JOIN users u ON u.id = s.user_id
      WHERE p.status IN ('qa_pending','qa_running','rejected')
      ORDER BY p.submitted_at ASC NULLS LAST LIMIT 200`
  );
  res.json({ queue: r.rows });
}));

// POST /products/admin/:id/force-approve (override admin)
router.post('/:id/force-approve',
  validate({ body: z.object({ reason: z.string().min(5) }) }),
  asyncHandler(async (req, res) => {
    await tx(async (c) => {
      await c.query(
        `UPDATE products SET status = 'approved', qa_verdict = 'approved', approved_at = NOW(),
                            approved_by = $1, published_at = COALESCE(published_at, NOW()), updated_at = NOW()
          WHERE id = $2`, [req.user.sub, req.params.id]
      );
      // reset SLA do seller (deu produto aprovado!)
      await c.query(
        `UPDATE sellers s SET sla_last_upload_at = NOW(),
                              sla_next_deadline_at = NOW() + (s.sla_days || ' days')::INTERVAL
          FROM products p WHERE p.id = $1 AND p.seller_id = s.id AND s.seller_class = 'class_b'`,
        [req.params.id]
      );
      await c.query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES ($1,$2,'product.force_approve','product',$3,'warn',$4::JSONB)`,
        [req.user.sub, req.user.role, req.params.id, JSON.stringify({ reason: req.body.reason })]
      );
    });
    // FIX-WORKER-7 pass 5: passa productId p/ invalidacao especifica detail/reviews/qna
    await invalidateProductCache(req.params.id);
    res.json({ ok: true });
  })
);

// POST /products/admin/:id/platform-take (Clausula Master Revenda Direta)
router.post('/:id/platform-take',
  validate({ body: z.object({ reason: z.string().min(5) }) }),
  asyncHandler(async (req, res, next) => {
    const r = await query('SELECT platform_resale_enabled, seller_id FROM products WHERE id = $1', [req.params.id]);
    if (!r.rows.length) return next(errorHandler.notFound());
    if (!r.rows[0].platform_resale_enabled) return next(errorHandler.forbidden('resale_not_allowed'));
    // Duplica produto como platform_owned (mantem original do seller)
    const dup = await query(
      `INSERT INTO products
        (seller_id, category_id, kind, status, slug, title, subtitle, description, short_description,
         price_cents, currency, license_kind, tech_stack, requirements, install_instructions,
         cover_image_url, gallery_urls, package_url, package_hash_sha256, package_size_bytes,
         is_platform_owned, platform_resale_enabled, qa_verdict, approved_at, approved_by, published_at)
       SELECT NULL, category_id, kind, 'platform_owned', slug || '-platform',
              title || ' (Oficial)', subtitle, description, short_description,
              price_cents, currency, license_kind, tech_stack, requirements, install_instructions,
              cover_image_url, gallery_urls, package_url, package_hash_sha256, package_size_bytes,
              TRUE, FALSE, 'approved', NOW(), $1, NOW()
         FROM products WHERE id = $2
         RETURNING id, slug`,
      [req.user.sub, req.params.id]
    );
    await query(
      `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
       VALUES ($1,$2,'product.platform_take','product',$3,'warn',$4::JSONB)`,
      [req.user.sub, req.user.role, req.params.id, JSON.stringify({ reason: req.body.reason, duplicate_id: dup.rows[0].id })]
    );
    log.warn({ original: req.params.id, platform_copy: dup.rows[0].id }, '[product.platform_take]');
    // FIX-WORKER-7 pass 5: passa productId p/ invalidacao especifica detail/reviews/qna
    await invalidateProductCache(req.params.id);
    res.json({ ok: true, platform_product: dup.rows[0] });
  })
);

// POST /products/admin/:id/archive
router.post('/:id/archive', asyncHandler(async (req, res) => {
  await query(`UPDATE products SET status = 'archived', archived_at = NOW(), updated_at = NOW() WHERE id = $1`, [req.params.id]);
  // FIX-WORKER-7 pass 5: invalida tambem detail/reviews/qna por slug
  await invalidateProductCache(req.params.id);
  res.json({ ok: true });
}));

module.exports = router;
