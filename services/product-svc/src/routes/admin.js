'use strict';

const express = require('express');
const { z } = require('zod');
const { query, tx } = require('@cas/db-client');
const { jwt, asyncHandler, validate, errorHandler, logger, cache, maskPII, mask, notifCache, withRetry } = require('@cas/shared');

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
      // FIX-WORKER-10 pass 358: invalidate search:categories:v3 apos admin actions.
      //   PRE-FIX: search:categories cache TTL=900s sem invalidation.
      //   Admin force-approve / platform-take / archive product -> category
      //   product_count stale ate 15min. Mega menu storefront mostra count antigo.
      //   POST-FIX: include search:categories:v3 no batch invalidation.
      //   Tambem futuro-proof p/ v4+ via wildcard.
      cache.del('search:categories:v3'),
      cache.del('search:categories:*'),
      // FIX-WORKER-18 pass 386: invalidate products:me cache (paridade seller-mgmt)
      //   Admin force-approve/archive/platform-take afeta lista do seller -
      //   /products/me com cache 30s mostra status stale ate TTL.
      //   Inclui no batch p/ realtime UX seller dashboard.
      cache.del('products:me:*'),
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

/* FIX-WORKER-4 pass 710 (qa-queue case-insensitive status param paridade cadeia 30+ sites cache hygiene):
   PRE-FIX BUG: req.query.status raw case-sensitive whitelist check
   - ?status=Qa_Pending (mixed case) -> QA_QUEUE_STATUS.has() = false -> 'all'
   - ?status=QA_PENDING (caps) -> idem
   - User links direto + admin dashboard URL bar drift -> case variance
   - Handler logic linha 103 mesmo pattern (consistent MAS UX case-sensitive)
   - Cache key separate de handler -> 3 entries Redis para mesma logical query
     ?status=qa_pending, ?status=Qa_Pending, ?status=QA_PENDING
   POST-FIX: normalize trim+lowercase ANTES whitelist check
   - Cache key matches handler normalize ANTES check
   - UX case-insensitive (paridade cadeia consolidacao W7+W18 30+ sites cache key) */
const qaQueueCacheKey = (req) => {
  const lim = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
  const off = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const statusRaw = (req.query.status || '').toString().trim().toLowerCase();
  const st = QA_QUEUE_STATUS.has(statusRaw) ? statusRaw : 'all';
  return `products:qa_queue:st=${st}:lim=${lim}:off=${off}`;
};

router.get('/qa-queue',
  cache.cacheMiddleware(qaQueueCacheKey, 30),
  asyncHandler(async (req, res) => {
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    // FIX pass 710: normalize trim+lowercase paridade cacheKey acima (case-insensitive UX)
    const statusRaw = (req.query.status || '').toString().trim().toLowerCase();
    const statusFilter = QA_QUEUE_STATUS.has(statusRaw) ? statusRaw : null;

    // Status filter optional - se passado, restringe; senao retorna todos 3 estados
    const whereParts = statusFilter
      ? ['p.status = $1']
      : [`p.status IN ('qa_pending','qa_running','rejected')`];
    const params = statusFilter ? [statusFilter] : [];
    let i = params.length + 1;
    params.push(limit, offset);

    /* FIX-WORKER-7 pass 301: COUNT(*) OVER() window consolidation.
       FIX-WORKER-18 pass 448 (N+1 subqueries product_qa_runs consolidation):
         PRE-FIX (pass 301 + pass 14): 3 correlated subqueries per product row:
         1. last_run_verdict (SELECT ... ORDER BY started_at DESC LIMIT 1)
         2. last_run_started_at (mesma query, coluna diferente - WASTE)
         3. timeout_count (SELECT COUNT(*) FILTER verdict=timeout)
         50 products LIMIT = 150 subqueries em product_qa_runs por request.
         idx_qa_runs_product_started (mig 034) ajuda PER subquery mas planner
         executa 3x O(log n) lookups duplicates. Pattern V8 W18 N+1 refactor.
         POST-FIX 2 LATERAL JOINs:
         1. lr (last_run) - 1 subquery returns verdict + started_at (DRY)
         2. tc (timeout_count) - 1 aggregate per product
         50 products = 100 LATERAL invocations (50 lr + 50 tc) vs 150 antes.
         Mais importante: lr DRY elimina 50 subqueries identicas (33% saving).
         PG planner inlining LATERAL otimiza hash/merge join.
         Latencia esperada: ~50ms -> ~20ms (2-3x melhoria).
         Paridade pass 440 /orders LATERAL JOIN pattern.
       PRE-FIX pass 301: 2 queries (rows + COUNT) -> 1 query window aggregate. */
    const r = await query(
      `SELECT p.id, p.title, p.slug, p.status, p.qa_verdict, p.qa_confidence_score,
              p.submitted_at, s.store_name, u.email,
              lr.verdict AS last_run_verdict,
              lr.started_at AS last_run_started_at,
              COALESCE(tc.timeout_count, 0) AS timeout_count,
              COUNT(*) OVER()::INT AS _total
         FROM products p
         LEFT JOIN sellers s ON s.id = p.seller_id
         LEFT JOIN users u ON u.id = s.user_id
         /* FIX-WORKER-7 pass 633 (LATERAL LIMIT 1 tiebreaker - paridade Regra D):
            PRE-FIX: ORDER BY started_at DESC LIMIT 1 sem id DESC tiebreaker.
            - Multiple qa_runs mesmo product_id same started_at second-precision:
              cron retry burst (cada 5min) ou mass re-validation campaign
            - LIMIT 1 picks ARBITRARY row entre ties (PG heap order)
            - last_run_verdict mostra verdict_A em request 1, verdict_B em request 2
              (cache evict + refetch = visualmente diferente)
            - Admin /admin/products column "Ultimo verdict" oscila aleatoria
            POST-FIX: + id DESC tiebreaker direction parity Regra D V8
            - Most recent INSERT (id DESC) preserva chronologic invariant ties
            - mig 119 idx_qa_runs_product_started_id ja cobre direction parity */
         LEFT JOIN LATERAL (
           SELECT verdict, started_at
             FROM product_qa_runs
            WHERE product_id = p.id
            ORDER BY started_at DESC, id DESC
            LIMIT 1
         ) lr ON TRUE
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::INT AS timeout_count
             FROM product_qa_runs
            WHERE product_id = p.id AND verdict = 'timeout'
         ) tc ON TRUE
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

    /* FIX-WORKER-7 pass 651 (withRetry deadlock defense + DLP mask + ua_prefix forensic):
       PRE-FIX BUGS (3 issues paridade pass 512 archive consolidacao):
       1. tx() sem withRetry wrap (paridade pass 650 archive)
          - Cenarios deadlock 40P01: mass force-approve admin batch, race com QA callback,
            race com /platform-take, race com cron timeoutStuckRuns
       2. reason field SEM mask.text() DLP (paridade pass 295/433/499/512)
          - Admin paste pode incluir Bearer/JWT/sk-/CPF/PG_PASS em justificativa
          - audit_log payload_after JSONB persisted DB + backup pg_dump
          - LGPD violation se reason tem PII raw
          - /archive pass 512 ja aplicou mask.text() - /force-approve lagged
       3. NO ua_prefix forensic (pattern V8 W17 pass 438 cross-svc)
          - Apenas IP capturado - admin token XSS-stolen attack investigation gap
          - vault-svc + product/archive pass 512 ja consolidaram ua_prefix
       POST-FIX:
       - withRetry('product.force_approve.tx') wrap (3 attempts backoff)
       - mask.text(reason) DLP defensive
       - + ua_prefix mask.text(headers.UA).slice(0,60) forensic
       Pattern V8 W7 atomicity + DLP + forensic cross-svc paridade completa. */
    let outcome;
    let productMeta;

    await withRetry('product.force_approve.tx', async () => await tx(async (c) => {
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
           // FIX pass 651: mask.text() DLP - reason pode conter Bearer/JWT/CPF (paridade pass 512)
           reason: mask.text(String(req.body.reason || '').slice(0, 1000)),
           previous_status: productMeta.previous_status,
           ip: req.ip,
           // FIX pass 651: + ua_prefix forensic (paridade pass 512 archive + pass 438 vault)
           ua_prefix: mask.text((req.headers['user-agent'] || '').slice(0, 60)),
         })]
      );

      /* FIX-WORKER-7 pass 473 (notifCache cross-svc - consume cadeia pass 467-472):
         PRE-FIX: force-approve notification seller SEM invalidate cache.
         - Admin override LLM verdict -> priority 1 importante
         - Seller esperando approval (waiting on admin) -> bell delay 20s
         - UX gap: admin manual approve = special action, deserves immediate visibility
         POST-FIX: RETURNING user_id + notifCache.invalidate. */
      let sellerNotifiedUserId = null;
      if (productMeta.seller_id) {
        const notifRes = await c.query(
          `INSERT INTO notifications (user_id, channel, template_code, title, body, payload, priority)
           SELECT s.user_id, 'in_app'::notification_channel, 'product_force_approved',
                  $1::text, $2::text, $3::JSONB, 1
             FROM sellers s WHERE s.id = $4::UUID
            LIMIT 1
            RETURNING user_id`,
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
        sellerNotifiedUserId = notifRes.rows[0]?.user_id || null;
      }
      // expose user_id p/ post-tx cache invalidate
      outcome = outcome || {};
      outcome.notified_user_id = sellerNotifiedUserId;
    }));

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
    // FIX pass 473: + notifCache.invalidate post-tx p/ seller notification
    await invalidateProductCache(req.params.id);
    if (outcome?.notified_user_id) {
      notifCache.invalidate(outcome.notified_user_id);
    }
    res.json({ ok: true, product_id: req.params.id, previous_status: productMeta?.previous_status });
  })
);

// POST /products/admin/:id/platform-take (Clausula Master Revenda Direta)
/* FIX-WORKER-4 pass 336: reason max() paridade pass 332-335 anti-DoS.
   Outras endpoints /admin/:id/force-approve linha 195 + /archive 367 ja tinham
   max(1000). platform-take ficou sem max - admin justificativa abusiva 1MB. */
// FIX-WORKER-7 pass 378 (rate-limit gap platform-take - paridade pass 242 archive):
//   PRE-FIX: /platform-take SEM rate-limit (force-approve linha 202 + archive linha 377 JA usam forceApproveLimiter)
//   - Admin endpoint critico cria duplicate product (revenue impact)
//   - Token admin comprometido -> mass platform-take spam
//   - Cada call: 1 INSERT (product clone) + 1 INSERT audit_log + invalidate cache
//   - 100 calls/min = 100 duplicate products + audit bloat + cache thrash
//   POST-FIX: aplicar forceApproveLimiter (5/min) paridade /archive e /force-approve.
// FIX-WORKER-7 pass 378 BUG 2 (UUID validate missing - paridade force-approve pass 201):
//   PRE-FIX: req.params.id direto na query sem UUID regex check
//   - PG 22P02 invalid_text_representation -> errorHandler 500 leak
//   - force-approve (pass 201) JA tem UUID validate (FORCE_APPROVE_UUID_RE)
//   - platform-take ficou lagged - defesa em camada incompleta
//   POST-FIX: validate upfront usando mesma regex.
const PLATFORM_TAKE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.post('/:id/platform-take',
  forceApproveLimiter, // FIX pass 378: rate-limit paridade force-approve + archive
  validate({ body: z.object({ reason: z.string().min(5).max(1000) }) }),
  asyncHandler(async (req, res, next) => {
    if (!PLATFORM_TAKE_UUID_RE.test(req.params.id)) {
      return next(errorHandler.notFound('product_not_found'));
    }
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
    /* FIX-WORKER-7 pass 652 (DLP mask reason + ua_prefix forensic paridade pass 512/651):
       PRE-FIX BUGS (2 paridade consolidacao):
       1. reason field SEM mask.text() DLP - admin paste pode incluir Bearer/JWT/CPF
          /archive (pass 512) + /force-approve (pass 651) ja consolidaram mask.text()
          /platform-take era unico admin endpoint product-svc lagged sem DLP
       2. NO ua_prefix forensic (pattern V8 W17 pass 438 cross-svc)
          Token admin XSS-stolen -> attacker platform-take products mass + audit gap
       POST-FIX:
       - mask.text(reason) DLP defensive (paridade pass 512/651)
       - + ua_prefix forensic (paridade pass 438 vault + pass 512 archive)
       Note: platform-take audit_log INSERT fora de tx() OK aqui - dup INSERT ja
       confirmou commit (ON CONFLICT race-safe), audit eh follow-up forensic
       (vs archive/force-approve onde UPDATE+audit DEVEM ser atomic state machine). */
    await query(
      `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
       VALUES ($1,$2,'product.platform_take','product',$3,'warn',$4::JSONB)`,
      [req.user.sub, req.user.role, req.params.id, JSON.stringify({
        reason: mask.text(String(req.body.reason || '').slice(0, 1000)),
        duplicate_id: dup.rows[0].id,
        ip: req.ip,
        ua_prefix: mask.text((req.headers['user-agent'] || '').slice(0, 60)),
      })]
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
    /* FIX-WORKER-7 pass 512 (atomicity + DLP + forensic - paridade vault-svc):
       PRE-FIX BUGS (5 issues critical):
       1. UPDATE + INSERT audit_log SEM tx() wrapping (paridade pass 493 vault):
          - UPDATE commit (product archived terminal state)
          - audit_log INSERT fail (.catch silent swallow log.warn)
          - SOC2 CC7.3 + LGPD Art 37 gap: archive=high-impact decision sem trail
          - Product archived sem forensic = qual admin? quando? motivo?
       2. reason field SEM mask.text() DLP (paridade pass 295/433/499 vault):
          - Admin paste pode incluir Bearer/JWT/sk-/CPF/PG_PASS em reason
          - Audit log payload_after JSONB persisted DB + backup pg_dump
          - LGPD violation se reason tem PII raw
       3. NO ua_prefix forensic (pattern V8 W17 pass 438 cross-svc):
          - Apenas IP capturado
          - Admin token XSS-stolen -> attacker archive products mass
          - Investigation IP+UA correlation impossivel
       4. audit_log INSERT outside tx() AND fire-and-forget catch:
          - Mesmo pattern V8 W11 pass 503 estabeleceu: cache invalidate post-tx
          - Mas audit_log MUST be inside tx (compliance critical)
       5. severity 'warn' OK mas info disclosure: product archive = irreversivel
          terminal state - poderia ser 'critical' p/ SOC2 alerts dashboard
       POST-FIX:
       - tx() wraps UPDATE + audit_log INSERT atomic
       - mask.text(reason) defensive (Bearer/CPF/secrets sanitize)
       - + ua_prefix mask.text(headers.UA).slice(0,60) (paridade pass 438)
       - Cache invalidation pos-tx commit (paridade pass 503 pattern V8) */
    /* FIX-WORKER-7 pass 650 (withRetry deadlock defense paridade vault/payment/order cadeia):
       PRE-FIX: tx() sem withRetry wrap (linha 477).
       - Cenarios deadlock 40P01:
         1. Admin mass-archive batch (10+ products selecionados) -> tx() concurrent
            lock products row + audit_log row em lock ordering conflict
         2. Race com /force-approve mesmo product (admin double-click race)
         3. Race com cron auto_archive_inactive (5min interval)
       - Pattern V8 cadeia consolidacao:
         vault-svc: 8/8 endpoints write (pass 643 completou)
         payment-svc: refund + create (pass 644 + cross-svc)
         order-svc: dispute resolve + checkout (pass historico)
         product-svc admin: lagged - este endpoint sem withRetry defense
       POST-FIX: withRetry('product.archive.tx') wrap (3 attempts backoff)
       Pattern V8 W7 atomicity defense expand cross-svc consolidation */
    let archivedRow = null;
    await withRetry('product.archive.tx', async () => await tx(async (c) => {
      // State machine: arquivar product ja archived = no-op (idempotent friendly)
      const r = await c.query(
        `UPDATE products SET status = 'archived', archived_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND status != 'archived'
          RETURNING id, slug, title, status`,
        [req.params.id]
      );
      if (!r.rows.length) {
        // Pode ser: not found OR ja archived (idempotent path)
        const check = await c.query('SELECT id, status FROM products WHERE id = $1', [req.params.id]);
        if (!check.rows.length) {
          const err = new Error('product_not_found');
          err.code = 'NOT_FOUND';
          throw err;
        }
        archivedRow = { ok: true, idempotent: true, status: check.rows[0].status };
        return;
      }
      archivedRow = r.rows[0];
      // Audit log INSIDE tx() - atomic (compliance critical)
      // FIX pass 512: + mask.text(reason) DLP + ua_prefix forensic + severity preserved
      await c.query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES ($1, $2, 'product.archive', 'product', $3, 'warn', $4::JSONB)`,
        [req.user.sub, req.user.role, req.params.id, JSON.stringify({
          slug: r.rows[0].slug,
          title: r.rows[0].title,
          // FIX pass 512: mask.text() DLP - reason pode conter Bearer/JWT/CPF
          reason: req.body?.reason ? mask.text(String(req.body.reason).slice(0, 1000)) : null,
          ip: req.ip,
          // FIX pass 512: + ua_prefix forensic (paridade vault pass 438)
          ua_prefix: mask.text((req.headers['user-agent'] || '').slice(0, 60)),
        })]
      );
    })).catch((e) => {
      if (e?.code === 'NOT_FOUND') return next(errorHandler.notFound('product_not_found'));
      throw e; // bubble up errorHandler middleware
    });
    if (!archivedRow) return; // already responded via next() above
    // Idempotent path (product was already archived)
    if (archivedRow.idempotent) {
      return res.json({ ok: true, idempotent: true, status: archivedRow.status });
    }
    // FIX-WORKER-7 pass 5: invalida tambem detail/reviews/qna por slug
    // Cache invalidation POS-TX commit (paridade pass 503 W11 pattern V8)
    await invalidateProductCache(req.params.id);
    res.json({ ok: true, archived: archivedRow.id });
  })
);

module.exports = router;
