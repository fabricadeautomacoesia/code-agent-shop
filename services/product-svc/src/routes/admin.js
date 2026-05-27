'use strict';

const express = require('express');
const { z } = require('zod');
const { query, tx } = require('@cas/db-client');
const { jwt, asyncHandler, validate, errorHandler, logger, cache, maskPII } = require('@cas/shared');

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
// FIX-WORKER-7 pass 67: 6 BUGS aplicando Pattern W7 (Regras D+E+I + LGPD + cache).
//
// BUG 1 *** Regra D TIEBREAKER MISSING *** ORDER BY submitted_at ASC NULLS LAST
//   2 products submitted_at NULL (rejected sem submit antes) -> ordem indefinida.
//   2 products mesmo submitted_at (bulk seller import) -> ordem indefinida.
//   FIX: + p.id ASC tiebreaker.
//
// BUG 2 *** Regra E PAGINATION MISSING *** hardcoded LIMIT 200
//   Em incidente QA (LLM down) 500+ products pendentes - admin so vê 200.
//   FIX: ?limit (1-200, default 50) + ?offset.
//
// BUG 3 *** ?status FILTER MISSING *** UX inflexivel
//   Admin precisa filtrar: ver SO qa_pending (fila normal), SO rejected
//   (reanalise prioridade), SO qa_running (verificar travados).
//   FIX: ?status enum filter (qa_pending|qa_running|rejected) opcional.
//
// BUG 4 *** LGPD PII LEAK *** u.email plain text p/ staff
//   PRE-FIX: SELECT u.email returned plain p/ ALL roles incluindo staff.
//   Staff sub-role só precisa contexto (Jo***@gmail.com), admin vê full.
//   Pattern W7 cross-svc estabelecido pass 57/59/60.
//   FIX: maskPII.email role-tier (admin=full, staff=masked).
//
// BUG 5 *** TOTAL COUNT MISSING *** UX paginacao UI
//   Sem total, frontend não sabe quantos pendentes total ("3 de 245").
//   FIX: COUNT(*) p/ summary stats.
//
// BUG 6 *** CACHE MISSING *** admin abre dashboard varias vezes/dia
//   QA queue muda quando cron QA processa (5-10min interval).
//   Cache 30s = warm-up + queue freshness aceitavel.
//   FIX: cache.cacheMiddleware 30s vary by status/limit/offset.
//
// Usa idx_qa_runs_product_started (W14 pass 6) - 1 scan por product_id ordenado DESC.
const QA_QUEUE_STATUS = new Set(['qa_pending','qa_running','rejected']);

const qaQueueCacheKey = (req) => {
  const lim = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
  const off = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const st = QA_QUEUE_STATUS.has(req.query.status) ? req.query.status : 'all';
  return `products:qa_queue:st=${st}:lim=${lim}:off=${off}`;
};

router.get('/qa-queue',
  cache.cacheMiddleware(qaQueueCacheKey, 30),
  asyncHandler(async (req, res) => {
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const statusFilter = QA_QUEUE_STATUS.has(req.query.status) ? req.query.status : null;

    // Status filter optional - se passado, restringe; senao retorna todos 3 estados
    const whereParts = statusFilter
      ? ['p.status = $1']
      : [`p.status IN ('qa_pending','qa_running','rejected')`];
    const params = statusFilter ? [statusFilter] : [];
    let i = params.length + 1;
    params.push(limit, offset);

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
        WHERE ${whereParts.join(' AND ')}
        ORDER BY p.submitted_at ASC NULLS LAST, p.id ASC
        LIMIT $${i++} OFFSET $${i++}`,
      params
    );

    // Total count + breakdown por status (UX stats UI)
    const countParams = params.slice(0, -2);
    const totalRes = await query(
      `SELECT COUNT(*)::INT AS total FROM products p WHERE ${whereParts.join(' AND ')}`,
      countParams
    );

    // LGPD role-tier email mask (admin=full, staff=masked)
    const isAdmin = req.user && req.user.role === 'admin';
    const queue = r.rows.map((row) => isAdmin ? row : ({
      ...row,
      email: maskPII.email(row.email),
    }));

    res.json({
      queue,
      total: totalRes.rows[0].total,
      limit, offset,
      status: statusFilter,
      has_more: (offset + queue.length) < totalRes.rows[0].total,
    });
  })
);

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
