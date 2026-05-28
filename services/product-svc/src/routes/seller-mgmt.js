'use strict';

const express = require('express');
const { z } = require('zod');
const { query, tx } = require('@cas/db-client');
const { jwt, asyncHandler, validate, errorHandler, logger, cache, rateLimiter, mask } = require('@cas/shared');

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

  /* FIX-WORKER-7 pass 320: COUNT(*) OVER() window consolidation.
     PRE-FIX: 2 queries (rows + COUNT) com WHERE+JOIN identicos +
     countParams = params.slice(0, -2) cleanup feio.
     Pattern V8 19+ endpoints (passes 178-319).
     POST-FIX: 1 query + strip _total + has_more. */
  const r = await query(
    `SELECT p.id, p.slug, p.title, p.status, p.kind, p.price_cents, p.currency,
            p.qa_verdict, p.qa_confidence_score,
            p.sales_count, p.avg_rating, p.review_count,
            p.created_at, p.published_at,
            COUNT(*) OVER()::INT AS _total
       FROM products p
       ${joinClause}
      WHERE ${whereParts.join(' AND ')}
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT $${limIdx} OFFSET $${offIdx}`,
    params
  );

  const total = r.rows[0]?._total ?? 0;
  const products = r.rows.map((row) => { const { _total, ...rest } = row; return rest; });

  res.json({
    products,
    total,
    limit,
    offset,
    has_more: (offset + products.length) < total,
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
    // FIX-WORKER-7 pass 267 (SQL injection defense-in-depth):
    //   PRE-FIX: cols.push(`${k} = $...`) interpolava k direto sem re-validate.
    //   `allowed` whitelist (linha 392-394) protege HOJE, mas frágil:
    //   - Se algum dia developer mudar fieldsProvided pra Object.keys() ou
    //     z.passthrough() em patchSchema -> SQL injection real
    //   - Defense-in-depth: re-validate column name inline contra Set whitelist
    //   - Pattern V8 W7 (registro auth pass 51 BUG 1) consolidado
    //   POST-FIX: inline ALLOWED_COLS Set + throw se key suspeita
    const ALLOWED_COLS = new Set(allowed);
    const cols = []; const vals = []; let i = 1;
    for (const k of fieldsProvided) {
      // Defense-in-depth: re-check k against whitelist (paranoid)
      if (!ALLOWED_COLS.has(k)) {
        log.error({ key: k, user: req.user.sub }, '[product.patch.suspicious_key] field bypass whitelist');
        outcome = { error: 'invalid_field' };
        return;
      }
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

  if (outcome?.error === 'invalid_field') return next(errorHandler.badRequest('invalid_field', 'Campo nao permitido detected'));
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

// POST /products/me/:id/submit - envia produto para fila QA
// FIX-WORKER-7 pass 84: 7 BUGS aplicando Pattern W7 (UUID+K+P+Q + validation + rate-limit + timeout).
//
// BUG 1 *** UUID VALIDATE MISSING *** PG 22P02 -> 500 leak
//   FIX: SUBMIT_UUID_RE upfront.
//
// BUG 2 *** Regra K *** SELECT FOR UPDATE missing -> race
//   PRE-FIX: UPDATE atomic mas sem FOR UPDATE em SELECT step.
//   Race entre seller submit + admin force-approve simultaneo:
//   - Seller dispara submit (status -> qa_pending)
//   - Admin simultaneo force-approve (status -> approved)
//   - Sem lock: ambos pode passar WHERE check antes commit
//   FIX: tx() wrap + SELECT FOR UPDATE OF products.
//
// BUG 3 *** Regra P AUDIT LOG MISSING ***
//   Submit -> QA = transicao critica state machine sem trail.
//   Compliance gap: produto pwned (seller scripted spam) sem rastro.
//   FIX: INSERT audit_log atomic dentro tx().
//
// BUG 4 *** REQUIRED FIELDS VALIDATION MISSING ***
//   PRE-FIX: WHERE status IN ('draft','rejected') aceita
//   product com description NULL / cover_image_url NULL / price_cents=0.
//   QA worker recebe lixo, dispara LLM calls waste, retorna rejected.
//   FIX: check required fields na SELECT antes UPDATE.
//   - description NOT NULL + length >= 50 (matches draftSchema)
//   - cover_image_url NOT NULL
//   - price_cents >= 0 (allow free) + currency set
//   400 explicit listing missing_required[] p/ UX claro.
//
// BUG 5 *** RATE-LIMIT MISSING ***
//   PRE-FIX: bot pode submit N products = spam QA queue.
//   FIX: submitLimiter 20/hr/seller (real users submetem ~1-3/dia).
//
// BUG 6 *** Regra Q idempotency UX ***
//   Re-submit produto em qa_pending: WHERE filter exclui mas response
//   eh "cannot_submit" generico - UX confuso.
//   FIX: response distinguishing "already_in_qa" vs "invalid_state".
//
// BUG 7 *** QA dispatch FIRE-AND-FORGET sem timeout ***
//   PRE-FIX: fetch() sem timeout - pode pendurar TCP wait indefinido se
//   qa-svc unreachable (rede particionada).
//   FIX: AbortController 5s timeout.
const SUBMIT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const submitLimiter = rateLimiter.createLimiter({
  windowMs: 60 * 60 * 1000, max: 20,
  message: 'Muitos produtos submetidos recentemente. Aguarde 1 hora.',
});

router.post('/:id/submit',
  submitLimiter,
  asyncHandler(async (req, res, next) => {
    // BUG 1: UUID validate upfront
    if (!SUBMIT_UUID_RE.test(req.params.id)) {
      return next(errorHandler.notFound('product_not_found'));
    }

    let outcome;
    let productInfo;

    await tx(async (c) => {
      // BUG 2 Regra K: SELECT FOR UPDATE + ownership + return state actual
      // FIX-WORKER-7 pass 279: include seller.asaas_wallet_id para warn seller
      // que payouts virao via debt queue se wallet nao configurada (paridade
      // pass 278 W11 cart warning, mas para seller-side ao submeter).
      const cur = await c.query(
        `SELECT p.id, p.title, p.status, p.description, p.cover_image_url,
                p.price_cents, p.currency,
                s.asaas_wallet_id
           FROM products p JOIN sellers s ON s.id = p.seller_id
          WHERE p.id = $1 AND s.user_id = $2
          FOR UPDATE OF p`,
        [req.params.id, req.user.sub]
      );
      if (!cur.rows.length) { outcome = { error: 'not_found' }; return; }
      const p = cur.rows[0];

      // BUG 6: distinguish state errors
      if (p.status === 'qa_pending' || p.status === 'qa_running') {
        outcome = { error: 'already_in_qa', current_status: p.status };
        return;
      }
      if (p.status === 'approved' || p.status === 'platform_owned') {
        outcome = { error: 'already_approved', current_status: p.status };
        return;
      }
      if (!['draft', 'rejected'].includes(p.status)) {
        outcome = { error: 'invalid_state', current_status: p.status };
        return;
      }

      // BUG 4: required fields validation
      const missing = [];
      if (!p.description || p.description.length < 50) missing.push('description');
      if (!p.cover_image_url) missing.push('cover_image_url');
      if (p.price_cents === null || p.price_cents === undefined) missing.push('price_cents');
      if (!p.currency) missing.push('currency');
      if (missing.length) { outcome = { error: 'missing_required', missing }; return; }

      // UPDATE atomic com guard status
      await c.query(
        `UPDATE products
            SET status = 'qa_pending', submitted_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND status IN ('draft','rejected')`,
        [req.params.id]
      );

      // BUG 3 Regra P: audit log atomic
      await c.query(
        `INSERT INTO audit_log
          (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES ($1, $2, 'product.submit', 'product', $3, 'info', $4::JSONB)`,
        [req.user.sub, req.user.role, req.params.id,
         JSON.stringify({
           previous_status: p.status,
           title: p.title,
           ip: req.ip,
         })]
      );

      // FIX-WORKER-7 pass 279: wallet warning flag p/ frontend dashboard-seller
      const walletConfigured = !!(p.asaas_wallet_id && p.asaas_wallet_id !== '');
      productInfo = { id: p.id, title: p.title, wallet_configured: walletConfigured };
    });

    if (outcome?.error === 'not_found') return next(errorHandler.notFound('product_not_found'));
    if (outcome?.error === 'already_in_qa') {
      return res.status(409).json({
        error: 'already_in_qa',
        message: 'Produto ja esta em fila de QA.',
        current_status: outcome.current_status,
      });
    }
    if (outcome?.error === 'already_approved') {
      return res.status(409).json({
        error: 'already_approved',
        message: 'Produto ja foi aprovado anteriormente.',
        current_status: outcome.current_status,
      });
    }
    if (outcome?.error === 'invalid_state') {
      return res.status(400).json({
        error: 'invalid_state',
        message: 'Produto nao pode ser submetido neste estado.',
        current_status: outcome.current_status,
      });
    }
    if (outcome?.error === 'missing_required') {
      return res.status(400).json({
        error: 'missing_required',
        message: 'Campos obrigatorios ausentes. Complete o produto antes de submeter.',
        missing: outcome.missing,
      });
    }

    // BUG 7: dispara QA com timeout 5s
    const qaUrl = `${process.env.UPSTREAM_QA || `http://tasks.cas_qa-svc:${process.env.PORT_QA || 3013}`}/qa/run`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    fetch(qaUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.QA_RUN_INTERNAL_TOKEN ? { 'x-internal-token': process.env.QA_RUN_INTERNAL_TOKEN } : {}),
      },
      body: JSON.stringify({ product_id: productInfo.id, triggered_by: req.user.sub }),
      signal: ctrl.signal,
    }).catch((e) => log.warn({ err: e.message }, '[qa.dispatch_failed]'))
      .finally(() => clearTimeout(timer));

    await invalidate(req.params.id);
    // FIX-WORKER-7 pass 279: response inclui wallet_warning quando seller submeteu
    // produto SEM wallet config. Frontend usa p/ exibir banner no /seller/products/[id].
    const response = {
      ok: true,
      message: 'Produto enviado para QA',
      product_id: productInfo.id,
      wallet_configured: productInfo.wallet_configured,
    };
    if (!productInfo.wallet_configured) {
      response.wallet_warning = 'Sua carteira Asaas nao esta configurada. Vendas serao aceitas, mas o repasse ficara em fila ate voce configurar em /seller/loja.';
    }
    res.json(response);
  })
);

// POST /products/me/:id/versions - publica nova versao (changelog)
// POST /products/me/:id/versions - publica nova versao (changelog)
// FIX-WORKER-7 pass 85: 8 BUGS aplicando Pattern W7 (UUID+A+K+P+Q+I + rate-limit + sanitize).
//
// BUG 1 *** UUID VALIDATE MISSING *** PG 22P02 -> 500 leak
//   FIX: VERSION_UUID_RE upfront.
//
// BUG 2 *** Regra A *** ownership sem status check
//   PRE-FIX: WHERE p.id + s.user_id - aceita product em qualquer status
//   incluindo deleted_at != NULL ou status='archived'/'rejected'.
//   Seller publica versao em produto deletado -> versao fantasma no DB.
//   Versao em product nao approved nunca aparece PDP -> waste.
//   FIX: + p.status IN ('approved','platform_owned') + p.deleted_at IS NULL.
//
// BUG 3 *** Regra K tx() + SELECT FOR UPDATE ***
//   PRE-FIX: SELECT ownership + 2x INSERT (version + notifications) sem lock.
//   Race: seller publica version + admin platform-take simultaneo -> versao
//   em product platform_owned com seller original (audit inconsistency).
//   FIX: tx() wrap + FOR UPDATE em products.
//
// BUG 4 *** Regra Q IDEMPOTENCY version unique ***
//   PRE-FIX: aceita 2 versions mesmo "v1.0.0" se DB nao tem unique constraint.
//   Se constraint existe: PG 23505 -> 500 leak.
//   FIX: ON CONFLICT (product_id, version) DO NOTHING + check rowcount.
//
// BUG 5 *** Regra I RETURNING * ***
//   product_versions.* expoe qa_run_id (cross-link interno) e potencialmente
//   internal_metadata em migrations futuras.
//   FIX: explicit fields.
//
// BUG 6 *** Regra P AUDIT LOG MISSING ***
//   Nova versao = mudanca critica produto publico (notifica TODOS owners
//   + wishlist subscribers). Compliance gap sem trail.
//   FIX: INSERT audit_log dentro tx().
//
// BUG 7 *** CHANGELOG XSS *** raw em body_html notification potencial
//   PRE-FIX: changelog raw em notifications.body. Se template_code renderizer
//   trata como HTML -> XSS no NotificationBell.
//   FIX: log uses plain text (body, nao body_html) - confirma defensivo + slice 500.
//   (Mantido behavior atual mas documenta defesa.)
//
// BUG 8 *** RATE-LIMIT MISSING ***
//   PRE-FIX: bot publica 100 versions consecutivas -> notification explosion
//   (wishlist subs * versions = N*M fanout).
//   FIX: versionPublishLimiter 10/hr/seller (real users 1-2 versions/semana).
const VERSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const versionPublishLimiter = rateLimiter.createLimiter({
  windowMs: 60 * 60 * 1000, max: 10,
  message: 'Muitas versoes publicadas recentemente. Aguarde 1 hora.',
});

router.post('/:id/versions',
  versionPublishLimiter,
  validate({ body: z.object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    changelog: z.string().min(5).max(5000),
    breaking_changes: z.boolean().default(false),
    package_url: z.string().url().optional(),
    package_hash_sha256: z.string().length(64).optional(),
  })}),
  asyncHandler(async (req, res, next) => {
    // BUG 1: UUID validate
    if (!VERSION_UUID_RE.test(req.params.id)) {
      return next(errorHandler.notFound('product_not_found'));
    }

    let outcome;
    let version;
    let prodMeta;

    await tx(async (c) => {
      // BUG 2+3: Regra A status + Regra K SELECT FOR UPDATE
      const owns = await c.query(
        `SELECT p.id, p.title, p.slug, p.status
           FROM products p JOIN sellers s ON s.id = p.seller_id
          WHERE p.id = $1 AND s.user_id = $2
            AND p.status IN ('approved','platform_owned')
            AND p.deleted_at IS NULL
          FOR UPDATE OF p`,
        [req.params.id, req.user.sub]
      );
      if (!owns.rows.length) { outcome = { error: 'not_found_or_not_approved' }; return; }
      prodMeta = owns.rows[0];

      // BUG 4 Regra Q: ON CONFLICT idempotent
      // BUG 5 Regra I: explicit fields no RETURNING
      const ins = await c.query(
        `INSERT INTO product_versions
          (product_id, version, changelog, breaking_changes, package_url, package_hash_sha256, qa_verdict)
         VALUES ($1,$2,$3,$4,$5,$6,'pending')
         ON CONFLICT (product_id, version) DO NOTHING
         RETURNING id, product_id, version, changelog, breaking_changes,
                   package_url, package_hash_sha256, qa_verdict, is_current, created_at`,
        [req.params.id, req.body.version, req.body.changelog, req.body.breaking_changes,
         req.body.package_url || null, req.body.package_hash_sha256 || null]
      );
      if (!ins.rows.length) { outcome = { error: 'version_already_exists', version: req.body.version }; return; }
      version = ins.rows[0];

      // BUG 6 Regra P: audit log atomic
      await c.query(
        `INSERT INTO audit_log
          (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES ($1, $2, 'product.version_publish', 'product_version', $3, $4, $5::JSONB)`,
        [req.user.sub, req.user.role, version.id,
         req.body.breaking_changes ? 'warn' : 'info',
         JSON.stringify({
           product_id: req.params.id,
           version: req.body.version,
           breaking_changes: req.body.breaking_changes,
           has_package_url: !!req.body.package_url,
           ip: req.ip,
         })]
      );
    });

    if (outcome?.error === 'not_found_or_not_approved') {
      return next(errorHandler.notFound('product_not_found_or_not_approved'));
    }
    if (outcome?.error === 'version_already_exists') {
      return res.status(409).json({
        error: 'version_already_exists',
        message: `Versao ${outcome.version} ja foi publicada para este produto.`,
        version: outcome.version,
      });
    }

    // MLB-NEW: notifica subscribers (wishlist + buyers ja owners) sobre nova versao.
    // FIX-WORKER-7 pass 85: notifications FORA do tx() principal (long-running fan-out
    // nao deve bloquear lock em products). Se falhar, version ja foi criada + audit.
    try {
      const title = prodMeta.title || 'Produto';
      const slug  = prodMeta.slug || '';
      const ver   = req.body.version;
      const bcWarn = req.body.breaking_changes ? ' (BREAKING CHANGES - revise antes de atualizar)' : '';

      // BUG 7 defesa: body texto plano slice 500 + body_html omitido
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

    res.status(201).json({ version });
  })
);

// POST /products/me/:id/qna/:qid/answer - DEPRECATED
// FIX-WORKER-7 pass 88: rota CONSOLIDADA em review-svc /qna/:id/answer (pass 36).
//
// HISTORIA:
// - pass 36 (review-svc) implementou Pattern W7 completo + 6 bugs corrigidos
// - pass 86 (product-svc) duplicou Pattern W7 fixes nesta rota
// - pass 88 (esta) consolida: product-svc HTTP 410 Gone + audit
//
// Frontend dashboard-seller usa apenas /qna/:id/answer (review-svc via gateway
// /api/qna/*). Pesquisa confirma: zero references a /products/me/:id/qna/:qid/answer
// em apps/dashboard-seller/src ou apps/storefront/src. Rota era DEAD CODE.
//
// RISCO PRE-FIX: handler full Pattern W7 (180 linhas) duplicado mantinha:
//   - 2 copias mesmo Pattern W7 fixes (manutencao 2x)
//   - Bypass vector: chamadas internas via tasks.cas_product-svc:3012 bypass gateway
//   - Drift risk: future bug fixes em review-svc podem nao chegar aqui
//
// PASS 88 ACAO:
//   - Remove handler implementation
//   - 410 Gone explicit + Location header redirect
//   - Audit log de tentativas (forense - quem ainda chama)
//   - Apos 30d sem hits no audit_log -> remover rota completamente (pass 100+)
//
// BUG 1 *** UUID VALIDATE MISSING *** PG 22P02 -> 500 leak (ambos params)
// BUG 2 *** Regra Q IDEMPOTENCY *** re-answer overwrite silencioso
//   PRE-FIX: UPDATE SET answer=... WHERE id=$3 - sem check answer IS NULL.
//   Seller responde mesma qna 10x - ultima sobrescreve anteriores. Forense
//   corrompido (audit perde history). Pattern Regra Q W7 pass 25/36.
//   FIX: WHERE answer IS NULL guard + 409 conflict se ja respondida.
// BUG 3 *** SILENT 404 *** rowcount=0 + res.json({ok:true})
//   PRE-FIX: UPDATE WHERE qna NAO existe ou nao eh do seller -> 0 rows ->
//   200 OK silencioso. Seller pensa "respondi" mas DB nao mudou.
//   FIX: rowcount check -> 404 not_found_or_not_owned.
// BUG 4 *** Regra K *** SELECT FOR UPDATE missing
//   2 seller answer simultaneous (raro mas possivel multi-tab) -> race.
//   FIX: tx() + FOR UPDATE em qna.
// BUG 5 *** Regra A *** ownership sem status check
//   PRE-FIX: WHERE q.product_id = p.id + s.user_id - aceita product
//   deletado/archived. Answer em qna de product deletado = compromisso
//   fantasma (qna aparecera se admin restaurar product).
//   FIX: + p.status IN ('approved','platform_owned') + p.deleted_at IS NULL.
// BUG 6 *** Regra P AUDIT LOG MISSING ***
//   Answer eh compromisso publico - compliance + Anti-fraude requer trail.
//   FIX: INSERT audit_log atomic.
// BUG 7 *** NOTIFICATION BUYER MISSING ***
//   Pattern pass 36 estabeleceu notif p/ asker quando seller responde.
//   PRE-FIX: buyer abre qna -> nunca sabe que recebeu resposta.
//   FIX: INSERT notifications atomic (fan-out p/ asked_by_user_id).
// BUG 8 *** is_hidden CHECK MISSING ***
//   Answer em qna moderada (hidden=TRUE) = waste (qna nunca aparece PDP).
//   FIX: AND q.is_hidden = FALSE.
// BUG 9 *** RATE-LIMIT MISSING ***
//   Bot pode automated answer spam (seller pwned).
//   FIX: qnaAnswerLimiter 30/hr/seller.
const QNA_ANSWER_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const qnaAnswerLimiter = rateLimiter.createLimiter({
  windowMs: 60 * 60 * 1000, max: 30,
  message: 'Muitas respostas recentes. Aguarde 1 hora.',
});

router.post('/:id/qna/:qid/answer',
  qnaAnswerLimiter,
  asyncHandler(async (req, res) => {
    // FIX-WORKER-7 pass 88: DEPRECATED - returns 410 Gone
    // Audit log de tentativas p/ forense (detectar callers internos legacy)
    /* FIX-WORKER-7 pass 323: user_agent mask.text() paridade pass 322 auth-svc.
       Pattern V8 cross-svc DLP audit_log - product-svc estava com gap. */
    try {
      await query(
        `INSERT INTO audit_log
          (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES ($1, $2, 'deprecated_route.qna_answer', 'route', $3, 'warn', $4::JSONB)`,
        [req.user?.sub || null, req.user?.role || null, req.params.qid,
         JSON.stringify({
           deprecated_path: '/products/me/:id/qna/:qid/answer',
           replacement_path: '/api/qna/:id/answer',
           ip: req.ip,
           user_agent: mask.text((req.headers['user-agent'] || '').slice(0, 200)),
         })]
      );
    } catch (_e) { /* audit best-effort */ }

    res.status(410)
      .set('Location', '/api/qna/' + req.params.qid + '/answer')
      .json({
        error: 'route_deprecated',
        message: 'Esta rota foi consolidada. Use POST /api/qna/:id/answer (review-svc).',
        replacement: '/api/qna/' + req.params.qid + '/answer',
        deprecated_since: 'pass_88',
      });
  })
);

// Handler antigo (180 linhas Pattern W7 implementacao completa pass 86)
// REMOVIDO em pass 88 - consolidacao em review-svc /qna/:id/answer.
// Apos 30d sem hits em audit_log 'deprecated_route.qna_answer' (forense),
// remover rota POST /:id/qna/:qid/answer completamente (pass 100+).

module.exports = router;
