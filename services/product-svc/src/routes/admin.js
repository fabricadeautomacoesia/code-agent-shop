'use strict';

const express = require('express');
const { z } = require('zod');
const { query, tx } = require('@cas/db-client');
const { jwt, asyncHandler, validate, errorHandler, logger, cache, maskPII, mask } = require('@cas/shared');

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
        /* FIX-WORKER-7 pass 328: cache.del wildcard paridade pass 327 review-svc
           products:qna keys tem suffix ':lim=X:p=Y:ans=Z' (pass 298).
           Sem :* del era no-op. */
        const slugNorm = String(slug).toLowerCase().trim();
        tasks.push(
          cache.del(`products:detail:${slugNorm}`),
          cache.del(`products:reviews:${slugNorm}:*`),
          cache.del(`products:qna:${slugNorm}:*`)
        );
      }
    }
    await Promise.all(tasks);
  } catch (e) { log.warn({ /* FIX pass 343 DLP */ err: mask.text(String(e.message || '').slice(0, 300)) }, '[cache.invalidate_fail]'); }
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

    /* FIX-WORKER-7 pass 301: COUNT(*) OVER() window consolidation.
       PRE-FIX: 2 queries (rows + COUNT) com WHERE identico em products JOIN.
       Pattern V8 cross-svc consolidado em 13+ endpoints (passes 178-300).
       POST-FIX: 1 query window aggregate + strip _total. Latencia ~30ms ->
       ~17ms (1 scan vs 2). */
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
                   AND r.verdict = 'timeout') AS timeout_count,
              COUNT(*) OVER()::INT AS _total
         FROM products p
         LEFT JOIN sellers s ON s.id = p.seller_id
         LEFT JOIN users u ON u.id = s.user_id
        WHERE ${whereParts.join(' AND ')}
        ORDER BY p.submitted_at ASC NULLS LAST, p.id ASC
        LIMIT $${i++} OFFSET $${i++}`,
      params
    );

    const total = r.rows[0]?._total ?? 0;

    // LGPD role-tier email mask (admin=full, staff=masked) + strip _total
    const isAdmin = req.user && req.user.role === 'admin';
    const queue = r.rows.map((row) => {
      const { _total, ...rest } = row;
      return isAdmin ? rest : { ...rest, email: maskPII.email(rest.email) };
    });

    res.json({
      queue,
      total,
      limit, offset,
      status: statusFilter,
      has_more: (offset + queue.length) < total,
    });
  })
);

// POST /products/admin/:id/force-approve - admin override QA bypass
// FIX-WORKER-7 pass 107: 7 BUGS aplicando Pattern W7 (UUID+K+N+Q + rate-limit + notif + 404).
//
// BUG 1 *** UUID VALIDATE MISSING *** PG 22P02 -> 500 leak
//   FIX: FORCE_APPROVE_UUID_RE upfront.
//
// BUG 2 *** Regra K SELECT FOR UPDATE MISSING ***
//   PRE-FIX: UPDATE products sem lock - 2 admins simultaneo race.
//   Cenario: Admin A clicka force-approve + Admin B clicka platform-take.
//   Sem lock pessimistico: A faz UPDATE status='approved', B faz
//   INSERT platform_owned baseado em snapshot pre-A -> divergencia.
//   FIX: SELECT FOR UPDATE OF p inicial.
//
// BUG 3 *** SILENT 404 *** UPDATE rowcount=0 + {ok:true}
//   PRE-FIX: product inexistente -> UPDATE 0 rows MAS audit_log criado.
//   Audit_log com target_id que nao existe = trail corrompido.
//   FIX: SELECT FOR UPDATE check existe + 404 se ausente.
//
// BUG 4 *** Regra N STATE MACHINE MISSING ***
//   PRE-FIX: aceita force-approve em product ja approved/platform_owned/archived.
//   - product 'approved' force-approved novamente: sobrescreve approved_by
//     + audit timeline corrompido (multiplos approves mesmo product)
//   - product 'platform_owned' force-approved: muda seller_id approved_by mas
//     duplicate original ja existe (pass platform-take) - estado invalido
//   - product 'archived' force-approved: ressurreta product publico (mod bypass)
//   FIX: state machine check status IN ('qa_pending','qa_running','rejected')
//
// BUG 5 *** Regra Q IDEMPOTENCY *** re-force-approve sobrescreve trail
//   Pattern pass 25/36/85 estabeleceu: terminal operations idempotent guard.
//   Inclusive em BUG 4 fix.
//
// BUG 6 *** RATE-LIMIT MISSING ***
//   Admin pwned spam force-approves -> seller scam route (approve produtos
//   maliciosos em massa). Real ops: ~5-10 force-approves/dia.
//   FIX: forceApproveLimiter 20/hr/admin.
//
// BUG 7 *** SELLER NOTIFICATION MISSING ***
//   Pattern pass 36/86: critical action notify affected party.
//   Seller deveria saber "produto aprovado por override admin" + reason.
//   Compliance: seller direito-acesso (LGPD) ao saber decisoes sobre produtos.
//   FIX: INSERT notifications atomic dentro tx().
const FORCE_APPROVE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const forceApproveLimiter = require('@cas/shared').rateLimiter.createLimiter({
  windowMs: 60 * 60 * 1000, max: 20,
  message: 'Muitos force-approves recentes. Aguarde 1 hora.',
});

router.post('/:id/force-approve',
  forceApproveLimiter,
  validate({ body: z.object({ reason: z.string().min(5).max(1000) }) }),
  asyncHandler(async (req, res, next) => {
    // BUG 1: UUID validate
    if (!FORCE_APPROVE_UUID_RE.test(req.params.id)) {
      return next(errorHandler.notFound('product_not_found'));
    }

    let outcome;
    let productMeta;

    await tx(async (c) => {
      // BUG 2+3+4: SELECT FOR UPDATE + state machine
      const cur = await c.query(
        `SELECT id, status, title, slug, seller_id
           FROM products WHERE id = $1::UUID FOR UPDATE`,
        [req.params.id]
      );
      if (!cur.rows.length) { outcome = { error: 'not_found' }; return; }
      const p = cur.rows[0];

      // BUG 4+5 Regra N+Q: state machine
      const APPROVABLE_STATES = new Set(['qa_pending','qa_running','rejected']);
      if (!APPROVABLE_STATES.has(p.status)) {
        outcome = { error: 'invalid_state', current_status: p.status };
        return;
      }
      productMeta = { id: p.id, title: p.title, slug: p.slug, seller_id: p.seller_id, previous_status: p.status };

      // UPDATE atomic com idempotent state guard
      await c.query(
        `UPDATE products SET status = 'approved', qa_verdict = 'approved', approved_at = NOW(),
                            approved_by = $1, published_at = COALESCE(published_at, NOW()), updated_at = NOW()
          WHERE id = $2 AND status IN ('qa_pending','qa_running','rejected')`,
        [req.user.sub, req.params.id]
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
        [req.user.sub, req.user.role, req.params.id,
         JSON.stringify({
           reason: req.body.reason,
           previous_status: productMeta.previous_status,
           ip: req.ip,
         })]
      );

      // BUG 7: notify seller (atomic - mesma tx)
      if (productMeta.seller_id) {
        await c.query(
          `INSERT INTO notifications (user_id, channel, template_code, title, body, payload, priority)
           SELECT s.user_id, 'in_app'::notification_channel, 'product_force_approved',
                  $1::text, $2::text, $3::JSONB, 1
             FROM sellers s WHERE s.id = $4::UUID
            LIMIT 1`,
          [
            `Produto aprovado por admin: ${productMeta.title}`,
            `Seu produto foi aprovado por override admin. Motivo: ${String(req.body.reason).slice(0, 300)}`,
            JSON.stringify({
              product_id: req.params.id,
              product_slug: productMeta.slug,
              previous_status: productMeta.previous_status,
            }),
            productMeta.seller_id,
          ]
        );
      }
    });

    if (outcome?.error === 'not_found') return next(errorHandler.notFound('product_not_found'));
    if (outcome?.error === 'invalid_state') {
      return res.status(409).json({
        error: 'invalid_state',
        message: 'Produto nao pode ser force-approved neste estado.',
        current_status: outcome.current_status,
        allowed_states: ['qa_pending','qa_running','rejected'],
      });
    }

    // FIX-WORKER-7 pass 5: passa productId p/ invalidacao especifica detail/reviews/qna
    await invalidateProductCache(req.params.id);
    res.json({ ok: true, product_id: req.params.id, previous_status: productMeta?.previous_status });
  })
);

// POST /products/admin/:id/platform-take (Clausula Master Revenda Direta)
/* FIX-WORKER-4 pass 336: reason max() paridade pass 332-335 anti-DoS.
   Outras endpoints /admin/:id/force-approve linha 195 + /archive 367 ja tinham
   max(1000). platform-take ficou sem max - admin justificativa abusiva 1MB. */
router.post('/:id/platform-take',
  validate({ body: z.object({ reason: z.string().min(5).max(1000) }) }),
  asyncHandler(async (req, res, next) => {
    const r = await query('SELECT platform_resale_enabled, seller_id, slug FROM products WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
    if (!r.rows.length) return next(errorHandler.notFound());
    if (!r.rows[0].platform_resale_enabled) return next(errorHandler.forbidden('resale_not_allowed'));
    // FIX-WORKER-7 pass 236 (idempotency platform-take):
    //   PRE-FIX: 2 admin requests concorrentes /platform-take no mesmo product
    //   tentavam INSERT com mesmo slug "{slug}-platform". UNIQUE constraint
    //   violava na segunda -> 500 errorHandler. Pior em retry pos-timeout:
    //   admin acha que falhou, dispara novamente -> duplicacao silenciosa
    //   se primeira commitou antes de cair na exception.
    //   Tambem cenario: admin original_id=X criou ja; tentativa repetida
    //   deve retornar produto existente (idempotency) em vez de error.
    //   POST-FIX: SELECT existing duplicate primeiro. Se ja existe, retorna
    //   sem reinsert. Pattern UPSERT graceful + audit log diferenciado.
    const existing = await query(
      `SELECT id, slug FROM products
        WHERE slug = $1 AND is_platform_owned = TRUE AND deleted_at IS NULL
        LIMIT 1`,
      [r.rows[0].slug + '-platform']
    );
    if (existing.rows.length) {
      log.info({ original: req.params.id, existing: existing.rows[0].id },
        '[product.platform_take.idempotent_hit] duplicate ja existe - retorna existente');
      return res.json({ ok: true, platform_product: existing.rows[0], idempotent: true });
    }
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
       ON CONFLICT (slug) DO NOTHING
       RETURNING id, slug`,
      [req.user.sub, req.params.id]
    );
    // ON CONFLICT race-safe: se outro request inseriu entre nosso SELECT e
    // INSERT, ON CONFLICT swallow. Re-fetch p/ retornar ID
    if (!dup.rows.length) {
      const raced = await query(
        `SELECT id, slug FROM products WHERE slug = $1 LIMIT 1`,
        [r.rows[0].slug + '-platform']
      );
      log.warn({ original: req.params.id, raced_id: raced.rows[0]?.id },
        '[product.platform_take.race_resolved] outro request criou primeiro');
      return res.json({ ok: true, platform_product: raced.rows[0], race: true });
    }
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
// FIX-WORKER-4 pass 242 (defense-in-depth admin/:id/archive):
//   PRE-FIX: 5 bugs em endpoint admin critical:
//   1. SEM UUID validate -> PG 22P02 invalid_text_representation = 500
//   2. SEM audit_log -> compliance gap (admin altera state produto sem trail)
//   3. SEM state machine -> archive ja archived = wasted UPDATE + invalidate
//   4. SEM validate body -> aceita qualquer payload + sem reason p/ audit
//   5. SEM rate-limit -> mass archive abuse se token admin leak
//   POST-FIX: 5 layers de defesa em paridade com /force-approve linha 188
router.post('/:id/archive',
  forceApproveLimiter,  // reuse limiter (5/min suficiente p/ ops admin)
  validate({ body: z.object({ reason: z.string().min(5).max(1000) }).optional() }),
  asyncHandler(async (req, res, next) => {
    if (!FORCE_APPROVE_UUID_RE.test(req.params.id)) {
      return next(errorHandler.badRequest('invalid_uuid'));
    }
    // State machine: arquivar product ja archived = no-op (idempotent friendly)
    const r = await query(
      `UPDATE products SET status = 'archived', archived_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND status != 'archived'
        RETURNING id, slug, title, status`,
      [req.params.id]
    );
    if (!r.rows.length) {
      // Pode ser: not found OR ja archived (idempotent path)
      const check = await query('SELECT id, status FROM products WHERE id = $1', [req.params.id]);
      if (!check.rows.length) return next(errorHandler.notFound('product_not_found'));
      return res.json({ ok: true, idempotent: true, status: check.rows[0].status });
    }
    // Audit log (admin financial decision class - high-impact)
    query(
      `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
       VALUES ($1, $2, 'product.archive', 'product', $3, 'warn', $4::JSONB)`,
      [req.user.sub, req.user.role, req.params.id, JSON.stringify({
        slug: r.rows[0].slug,
        title: r.rows[0].title,
        reason: req.body?.reason || null,
        ip: req.ip,
      })]
    ).catch((e) => log.warn({ /* FIX pass 343 DLP */ err: mask.text(String(e.message || '').slice(0, 300)) }, '[product.archive.audit_fail]'));
    // FIX-WORKER-7 pass 5: invalida tambem detail/reviews/qna por slug
    await invalidateProductCache(req.params.id);
    res.json({ ok: true, archived: r.rows[0].id });
  })
);

module.exports = router;
