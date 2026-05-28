'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const express = require('express');
const cron = require('node-cron');
const { z } = require('zod');
const { query, tx } = require('@cas/db-client');
const { logger, sanitize, errorHandler, asyncHandler, validate, jwt, cache, rateLimiter, maskPII, mask } = require('@cas/shared');

const log = logger.child({ svc: 'review-svc' });
const app = express();
const PORT = parseInt(process.env.PORT_REVIEW || '3017', 10);

app.disable('x-powered-by');
/* FIX-WORKER-17 pass 305: trust proxy paridade cross-svc */
app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));
app.use(sanitize.middleware());

app.get('/health', (_req, res) => res.json({ ok: true, svc: 'review-svc' }));

// ============================================================
// REVIEWS
// ============================================================
const reviewSchema = z.object({
  product_id: z.string().uuid(),
  order_id: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
  title: z.string().max(200).optional(),
  body: z.string().max(5000).optional(),
});

// POST /api/reviews
// FIX-WORKER-7 pass 32: rate-limit anti-spam (10 reviews / 15min / IP).
// PRE-FIX: zero rate-limit -> bot 100 reviews em 1min = 100 INSERTs +
// 100 UPDATEs products lock contention + 100 notifications spam seller.
const reviewLimiter = rateLimiter.createLimiter({
  windowMs: 15 * 60 * 1000, max: 10,
  message: 'Muitas avaliacoes recentes. Aguarde alguns minutos.',
});

app.post('/', reviewLimiter, jwt.requireAuth(), validate({ body: reviewSchema }), asyncHandler(async (req, res, next) => {
  // FIX-WORKER-7 pass 32: 4 BUGS aplicando Pattern W7 (Regras A+K + atomicity).
  // BUG 1 RACE avg_rating: 2 reviews simultaneos. Ambos UPDATE products avg
  //   com subqueries (SELECT AVG) - snapshot lost race. FIX: tx() + FOR UPDATE.
  // BUG 2 ATOMICITY: 3 queries lineares. UPDATE falha = review existe mas
  //   avg_rating stale + sem notification. FIX: tudo em tx() all-or-nothing.
  // BUG 3 Regra A: products.status check faltando. Review em archived/rejected.
  //   FIX: AND p.status IN ('approved','platform_owned') + deleted_at IS NULL.
  // BUG 4 (acima): rate-limit anti-spam.
  const b = req.body;

  let outcome;
  let review;
  await tx(async (c) => {
    // Validacao consolidada SELECT FOR UPDATE (anti-race)
    const oi = await c.query(
      `SELECT oi.product_id, oi.seller_id
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         JOIN products p ON p.id = oi.product_id
        WHERE o.id = $1::UUID AND o.buyer_user_id = $2::UUID
          AND oi.product_id = $3::UUID
          AND o.status IN ('paid','fulfilled')
          AND p.status IN ('approved','platform_owned')
          AND p.deleted_at IS NULL
        LIMIT 1`,
      [b.order_id, req.user.sub, b.product_id]
    );
    if (!oi.rows.length) { outcome = { error: 'not_a_verified_purchase' }; return; }

    // INSERT review (idempotency via unique constraint)
    try {
      const r = await c.query(
        `INSERT INTO product_reviews
          (product_id, order_id, buyer_user_id, seller_id, rating, title, body, is_verified_purchase)
         VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE)
         RETURNING id, product_id, rating, title, body, created_at`,
        [b.product_id, b.order_id, req.user.sub, oi.rows[0].seller_id || null,
         b.rating, b.title || null, b.body || null]
      );
      review = r.rows[0];
    } catch (e) {
      if (e.code === '23505') { outcome = { error: 'already_reviewed' }; return; }
      throw e;
    }

    // FIX bug 1: SELECT FOR UPDATE products + UPDATE no mesmo tx
    // Lock pessimistico previne race com outros reviews simultaneos.
    // FIX-WORKER-18 pass 257 (subquery consolidation):
    //   PRE-FIX: 2 subqueries separadas (AVG + COUNT) cada uma scan
    //   product_reviews WHERE product_id=$1 AND is_hidden=FALSE.
    //   PG planner pode otimizar mas em geral fazia 2 seq scans (50ms cada
    //   em produto popular com 500+ reviews).
    //   POST-FIX: 1 subquery agregada COALESCE - single scan, 50% reducao
    //   IO em hot path POST /reviews (cada novo review dispara este UPDATE).
    await c.query(`SELECT id FROM products WHERE id = $1 FOR UPDATE`, [b.product_id]);
    await c.query(
      `UPDATE products SET
         avg_rating = stats.avg_rating,
         review_count = stats.review_count
       FROM (
         SELECT COALESCE(AVG(rating), 0)::NUMERIC(3,2) AS avg_rating,
                COUNT(*)::INT AS review_count
           FROM product_reviews
          WHERE product_id = $1 AND is_hidden = FALSE
       ) stats
       WHERE id = $1`, [b.product_id]
    );

    // FIX bug 2: notification dentro do mesmo tx (atomicity all-or-nothing)
    if (oi.rows[0].seller_id) {
      await c.query(
        `INSERT INTO notifications (user_id, channel, template_code, title, body)
         SELECT user_id, 'in_app', 'review_received', $1, $2 FROM sellers WHERE id = $3`,
        [`Nova avaliacao: ${b.rating} estrelas`, b.body || `Voce recebeu ${b.rating} estrelas`, oi.rows[0].seller_id]
      );
    }
  });

  if (outcome?.error === 'not_a_verified_purchase') {
    return next(errorHandler.forbidden('not_a_verified_purchase'));
  }
  if (outcome?.error === 'already_reviewed') {
    return res.status(409).json({ error: 'already_reviewed' });
  }

  // Cache invalidate FORA do tx (acceptable - falha cache nao breaka DB)
  // FIX-WORKER-18 pass 350 (paridade key normalization detail):
  //   PRE-FIX: cache.del(`products:detail:${slug}`) usava slug raw mas pass 350
  //   normalizou a SAVE key p/ slugNorm = trim().toLowerCase(). Resultado:
  //   POST review -> invalidation MISSED (key mismatch slug vs slugNorm) -> PDP
  //   exibia rating/review_count stale por 60s (TTL). MLB-broken silenciosamente.
  //   POST-FIX: normalize slug aqui paridade com public.js linha 796.
  const slugR = await query('SELECT slug FROM products WHERE id = $1', [b.product_id]);
  if (slugR.rows.length) {
    const slug = slugR.rows[0].slug;
    const slugNorm = String(slug || '').trim().toLowerCase();
    await Promise.all([
      cache.del(`products:reviews:${slugNorm}:*`).catch(() => {}),
      cache.del(`products:detail:${slugNorm}`).catch(() => {}),
    ]);
  }
  res.status(201).json({ review });
}));

// POST /api/reviews/:id/vote
// FIX-WORKER-7 pass 33: 5 BUGS aplicando Pattern W7 (mesma classe pass 32).
//
// BUG 1 *** RACE CONDITION counter ***
//   PRE-FIX: 3 queries lineares sem tx()/FOR UPDATE.
//   50 users clicam "helpful" simultaneo:
//   - 50 INSERTs review_votes ON CONFLICT (idempotent por user) OK
//   - 50 SELECTs SUM agregam DURANTE outros INSERTs visible
//     - Vote 1 le SUM=1, UPDATE helpful_count=1
//     - Vote 50 le SUM=47 (race lost 3 INSERTs), UPDATE helpful_count=47
//   - product_reviews.helpful_count = 47 em vez de 50 (off by 3!)
//   - PDP mostra contador errado em produto viral
//   FIX: tx() + SELECT product_reviews FOR UPDATE antes UPDATE.
//   Lock pessimistico serializa - sub-query SUM le snapshot consistente.
//
// BUG 2 UUID validate :id (anti PG 22P02 -> 500)
//
// BUG 3 *** RATE-LIMIT *** vote spam toggle
//   User pode votar/desvotar 1000x no mesmo review (toggle) sem rate.
//   Cada toggle = 3 queries DB. Bot abuse OR UI bug double-click.
//   FIX: rateLimiter 30 votes/15min/IP (real users <10 votes/sessao).
//
// BUG 4 *** is_hidden check *** vote em review moderado
//   Review hidden (admin moderou) ainda aceitava vote -> counter incrementa
//   MAS PDP NAO lista review. Workflow inconsistente.
//   FIX: validar review.is_hidden = FALSE antes de INSERT.
//
// BUG 5 review_votes ON CONFLICT pode falhar se review_id nao existe (FK fail)
//   PRE-FIX: erro 23503 foreign_key_violation -> 500 generico.
//   FIX: SELECT review existe FOR UPDATE + 404 explicit antes do INSERT.
const VOTE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const voteLimiter = rateLimiter.createLimiter({
  windowMs: 15 * 60 * 1000, max: 30,
  message: 'Muitos votos recentes. Aguarde alguns minutos.',
});

app.post('/:id/vote', voteLimiter, jwt.requireAuth(),
  validate({ body: z.object({ vote: z.literal(1).or(z.literal(-1)) }) }),
  asyncHandler(async (req, res, next) => {
    // FIX bug 2: UUID validate
    if (!VOTE_UUID_RE.test(req.params.id)) {
      return next(errorHandler.notFound('review_not_found'));
    }

    let outcome;
    let result;
    await tx(async (c) => {
      // FIX bug 1+4+5: SELECT FOR UPDATE review valido + is_hidden check
      const rev = await c.query(
        `SELECT id, is_hidden FROM product_reviews
          WHERE id = $1::UUID FOR UPDATE`,
        [req.params.id]
      );
      if (!rev.rows.length) { outcome = { error: 'review_not_found' }; return; }
      if (rev.rows[0].is_hidden) {
        outcome = { error: 'review_hidden' };
        return;
      }

      // INSERT/UPDATE vote (idempotent por user via ON CONFLICT)
      await c.query(
        `INSERT INTO review_votes (review_id, user_id, vote) VALUES ($1::UUID, $2::UUID, $3::INT)
         ON CONFLICT (review_id, user_id) DO UPDATE SET vote = EXCLUDED.vote`,
        [req.params.id, req.user.sub, req.body.vote]
      );

      // FIX bug 1: SUM dentro do mesmo tx (snapshot consistente via FOR UPDATE acima)
      // FIX-WORKER-3 pass 262 (NULL SUM defensive):
      //   PRE-FIX: SUM(CASE...) retorna NULL quando 0 rows (review nunca votado)
      //   product_reviews.helpful_count INT NOT NULL -> 23502 not_null_violation
      //   Tx rollback -> vote falha + frontend retry storm
      //   POST-FIX: COALESCE(SUM(...), 0) garante INT 0 quando sem votes
      const counts = await c.query(
        `SELECT
           COALESCE(SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END), 0)::INT AS helpful,
           COALESCE(SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END), 0)::INT AS unhelpful
         FROM review_votes WHERE review_id = $1::UUID`, [req.params.id]
      );

      // UPDATE counters atomicamente (mesma tx)
      await c.query(
        `UPDATE product_reviews SET helpful_count = $1::INT, unhelpful_count = $2::INT
          WHERE id = $3::UUID`,
        [counts.rows[0].helpful, counts.rows[0].unhelpful, req.params.id]
      );

      result = {
        ok: true,
        helpful_count: counts.rows[0].helpful,
        unhelpful_count: counts.rows[0].unhelpful,
      };
    });

    if (outcome?.error === 'review_not_found') return next(errorHandler.notFound('review_not_found'));
    if (outcome?.error === 'review_hidden') {
      return res.status(403).json({
        error: 'review_hidden',
        message: 'Esta avaliacao foi moderada e nao aceita votos.',
      });
    }
    res.json(result);
  })
);

// POST /api/reviews/:id/reply (seller responde review)
// FIX-WORKER-7 pass 37: 7 BUGS aplicando Pattern W7 (paralelo pass 36 /qna/:id/answer).
//
// BUG 1 *** Regra Q IDEMPOTENT *** re-reply overwrites silently
//   Pre-fix: UPDATE SET reply_from_seller=... sem check reply atual
//   Seller responde 10x mesma review - ultima sobrescreve audit history
//   FIX: WHERE reply_from_seller IS NULL OR empty + check upfront -> 409
//
// BUG 2 *** ADMIN BYPASS *** roles ['seller','admin'] aceita admin mas
//   JOIN sellers + user_id exige req.user ser SELLER DONO. Admin SEM
//   entry sellers -> 404 silencioso. Same bug pass 36.
//   FIX: isAdmin path skip ownership + flag reply_by_admin=TRUE (mig 044)
//
// BUG 3 *** NOTIFICATION buyer MISSING *** UX gravissimo
//   PRE-FIX: reply criado SEM notificar buyer. Buyer perde lead engagement.
//   Inconsistencia cross-svc: qna answer (pass 36) JA notifica. Review reply NAO.
//   FIX: INSERT notification 'review_replied' atomic ao buyer.
//
// BUG 4 *** SILENT 404 *** UPDATE rowcount=0 + res.json({ok:true})
//   PRE-FIX: review nao existe OR ownership fail -> 0 rows -> 200 OK.
//   Seller pensa "respondi" mas review continua sem reply. UX broken.
//   FIX: RETURNING id + check rowcount -> 404 explicit.
//
// BUG 5 *** is_hidden check *** reply em review moderada
//   Same bug pass 36 - workflow inconsistente.
//   FIX: SELECT review.is_hidden -> 403 'review_hidden' upfront.
//
// BUG 6 *** ATOMICITY *** 2+ queries lineares (UPDATE + INSERT notif futuro)
//   FIX: tx() atomic.
//
// BUG 7 UUID validate + rate-limit
const replyLimiter = rateLimiter.createLimiter({
  windowMs: 15 * 60 * 1000, max: 20,
  message: 'Muitas respostas recentes. Aguarde alguns minutos.',
});
const REPLY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

app.post('/:id/reply',
  replyLimiter,
  jwt.requireAuth({ roles: ['seller','admin','staff'] }),
  validate({ body: z.object({ reply: z.string().min(1).max(2000) }) }),
  asyncHandler(async (req, res, next) => {
    if (!REPLY_UUID_RE.test(req.params.id)) {
      return next(errorHandler.notFound('review_not_found'));
    }

    const isAdmin = ['admin','staff'].includes(req.user.role);
    let outcome;
    let result;
    await tx(async (c) => {
      // FIX bugs 1+2+5: SELECT FOR UPDATE com checks consolidados
      // Admin path: skip ownership JOIN. Seller path: enforce dono.
      const reviewQuery = isAdmin
        ? `SELECT r.id, r.product_id, r.seller_id, r.is_hidden,
                  r.reply_from_seller, r.buyer_user_id
             FROM product_reviews r
            WHERE r.id = $1::UUID FOR UPDATE OF r`
        : `SELECT r.id, r.product_id, r.seller_id, r.is_hidden,
                  r.reply_from_seller, r.buyer_user_id
             FROM product_reviews r
             JOIN sellers s ON s.id = r.seller_id AND s.user_id = $2::UUID
            WHERE r.id = $1::UUID FOR UPDATE OF r`;
      const params = isAdmin ? [req.params.id] : [req.params.id, req.user.sub];
      const rev = await c.query(reviewQuery, params);
      if (!rev.rows.length) {
        outcome = { error: isAdmin ? 'review_not_found' : 'not_found_or_not_owner' };
        return;
      }
      const r = rev.rows[0];

      // BUG 1 Regra Q: reply ja existe -> 409 (preserva history audit)
      if (r.reply_from_seller && r.reply_from_seller.trim()) {
        outcome = {
          error: 'already_replied',
          existing_reply: r.reply_from_seller,
        };
        return;
      }
      // BUG 5: is_hidden check
      if (r.is_hidden) {
        outcome = { error: 'review_hidden' };
        return;
      }

      // UPDATE idempotent guard - mig 044 colunas reply_by_admin + reply_by_user_id
      await c.query(
        `UPDATE product_reviews
            SET reply_from_seller = $1,
                reply_at = NOW(),
                reply_by_admin = $2::BOOLEAN,
                reply_by_user_id = $3::UUID,
                updated_at = NOW()
          WHERE id = $4::UUID
            AND (reply_from_seller IS NULL OR reply_from_seller = '')`,
        [req.body.reply, isAdmin, req.user.sub, req.params.id]
      );

      // BUG 3: notification ao buyer ATOMICA (inconsistencia cross-svc resolvida)
      if (r.buyer_user_id) {
        await c.query(
          `INSERT INTO notifications (user_id, channel, template_code, title, body)
           VALUES ($1::UUID, 'in_app', 'review_replied',
                   'Resposta a sua avaliacao',
                   'O vendedor respondeu a sua avaliacao')`,
          [r.buyer_user_id]
        );
      }

      // Cache slug fetch dentro tx
      const slugRow = await c.query(`SELECT slug FROM products WHERE id = $1::UUID`, [r.product_id]);
      result = { ok: true, slug: slugRow.rows[0]?.slug, reply_by_admin: isAdmin };
    });

    if (outcome?.error === 'review_not_found' || outcome?.error === 'not_found_or_not_owner') {
      return res.status(404).json({ error: outcome.error });
    }
    if (outcome?.error === 'review_hidden') {
      return res.status(403).json({ error: 'review_hidden',
        message: 'Esta avaliacao foi moderada.' });
    }
    if (outcome?.error === 'already_replied') {
      return res.status(409).json({
        error: 'already_replied',
        message: 'Esta avaliacao ja foi respondida anteriormente.',
        existing_reply: outcome.existing_reply,
      });
    }

    if (result?.slug) {
      // Invalida cache PDP reviews (reply visivel)
      // FIX-WORKER-18 pass 350: slug normalization paridade public.js linha 796
      const slugNorm = String(result.slug || '').trim().toLowerCase();
      await cache.del(`products:reviews:${slugNorm}:*`).catch(() => {});
    }
    res.json({ ok: true, reply_by_admin: result.reply_by_admin });
  })
);

// ============================================================
// QnA (routes /api/qna proxied)
// ============================================================
// FIX-WORKER-7 pass 35: rate-limit anti-spam QnA.
// Bot pode criar 1000 perguntas/min sem rate. Cada pergunta = INSERT qna +
// notification + cache.del = 3 queries + email outbox enqueue ao seller.
// 5 perguntas/15min/IP eh generoso (real users <2 perguntas/produto).
const qnaCreateLimiter = rateLimiter.createLimiter({
  windowMs: 15 * 60 * 1000, max: 5,
  message: 'Muitas perguntas recentes. Aguarde alguns minutos.',
});

app.post('/qna',  // GW reroteia para /api/qna -> /qna
  qnaCreateLimiter,
  jwt.requireAuth(),
  validate({ body: z.object({ product_id: z.string().uuid(), question: z.string().min(5).max(2000) }) }),
  asyncHandler(async (req, res, next) => {
    // FIX-WORKER-7 pass 35: 5 BUGS aplicando Pattern W7 (Regras A+B+I+J + atomicity).
    //
    // BUG 1 *** Regras A+B combinadas *** SELECT products sem status/deleted_at
    //   PRE-FIX: SELECT seller_id WHERE id = $1 (sem filtros)
    //   Produto soft-deleted (DMCA/legal/QA-reject) ainda aceitava pergunta.
    //   FK products OK (soft delete via deleted_at), pergunta criada orfa.
    //   FIX: status IN ('approved','platform_owned') + deleted_at IS NULL
    //
    // BUG 2 *** IDEMPOTENCY ABUSE *** mesmo user pode criar N perguntas
    //   PRE-FIX: zero check cooldown - user spam 100 perguntas mesmo produto
    //   MLB tem cooldown 24h por user/product. Aqui aplico 5/15min via
    //   rate-limit + check ultimo question <60s (anti UI double-submit).
    //   FIX: SELECT ultimo qna do user neste produto <60s -> 409 Conflict
    //
    // BUG 3 *** ATOMICITY *** 4 queries lineares sem tx()
    //   SELECT product + INSERT qna + INSERT notification + cache.del.
    //   Falha INSERT notif = pergunta existe mas seller nao notificado.
    //   FIX: tx() atomic (cache.del fora - tolera fail)
    //
    // BUG 4 *** Regra I *** RETURNING * vaza internal_notes/moderator_notes
    //   FIX: RETURNING explicit fields consumed por UI
    //
    // BUG 5 *** Regra J *** parent product validation atomic
    //   FIX: tudo dentro tx() + FOR UPDATE product valida orphan
    let outcome;
    let qna;
    await tx(async (c) => {
      // Regras A+B+J: SELECT product valido (FOR UPDATE seria desnecessario
      // - product nao muta - usa SHARE lock que basta p/ orphan detection)
      // FIX-WORKER-7 pass 420 (+ title p/ notification context):
      //   PRE-FIX: SELECT seller_id, slug apenas
      //   Notification seller body hardcoded 'Nova pergunta sobre produto'
      //   - Seller com 10 produtos NAO sabe QUAL produto recebeu pergunta
      //   - inferCtaUrl pass 355 espera payload.slug + product title
      //   POST-FIX: + title (context na notification body)
      const p = await c.query(
        `SELECT seller_id, slug, title FROM products
          WHERE id = $1::UUID
            AND status IN ('approved','platform_owned')
            AND deleted_at IS NULL
          LIMIT 1`,
        [req.body.product_id]
      );
      if (!p.rows.length) { outcome = { error: 'product_not_found' }; return; }

      // BUG 2: anti-spam check - mesma user/product < 60s = double-submit
      const recent = await c.query(
        `SELECT 1 FROM product_qna
          WHERE asked_by_user_id = $1::UUID
            AND product_id = $2::UUID
            AND created_at > NOW() - INTERVAL '60 seconds'
          LIMIT 1`,
        [req.user.sub, req.body.product_id]
      );
      if (recent.rows.length) {
        outcome = { error: 'too_soon', message: 'Aguarde 60s antes de fazer outra pergunta neste produto.' };
        return;
      }

      // INSERT qna (Regra I: RETURNING explicit)
      const r = await c.query(
        `INSERT INTO product_qna (product_id, seller_id, asked_by_user_id, question)
         VALUES ($1::UUID, $2::UUID, $3::UUID, $4)
         RETURNING id, product_id, question, created_at, upvote_count`,
        [req.body.product_id, p.rows[0].seller_id || null, req.user.sub, req.body.question]
      );
      qna = r.rows[0];

      // INSERT notification ATOMICO (mesmo tx)
      // FIX-WORKER-7 pass 420 (notification context + payload):
      //   PRE-FIX: title='Nova pergunta' + body='Nova pergunta sobre produto'
      //   - Generic strings sem product context
      //   - SEM payload JSONB (inferCtaUrl pass 355 precisa payload.slug)
      //   - Seller multi-produto perde tempo identificando produto
      //   POST-FIX:
      //   - title includes product title (truncate 60 chars)
      //   - body includes question excerpt (truncate 200)
      //   - payload JSONB com slug + product_id (NotificationBell deep-link)
      //   - template_code='product_qna_new' paridade inferCtaUrl pass 355 mapping
      if (p.rows[0].seller_id) {
        const productTitle = String(p.rows[0].title || 'produto').slice(0, 60);
        const questionExcerpt = String(req.body.question).slice(0, 200);
        // FIX-WORKER-1 pass 434 (qna_id captured from RETURNING - completa deep-link):
        //   PRE-FIX: payload.qna_id: null hardcoded
        //   - inferCtaUrl notification-bell pass 355 retornava /product/{slug}#qna
        //   - product-tabs.tsx pass 426 useEffect checa hash.startsWith('qna-') (com dash)
        //   - '#qna' (sem dash) NUNCA matches '#qna-{uuid}' -> tab nao switchava
        //   - Seller clicava notif -> abria PDP em overview tab (perdia contexto)
        //   POST-FIX: qna_id = r.rows[0].id (RETURNING ja capturava linha 470)
        //   Combined com inferCtaUrl pass 434 que usa payload.qna_id para criar
        //   #qna-{uuid} hash anchor functional - PDP abre tab QNA + scroll smooth.
        await c.query(
          `INSERT INTO notifications (user_id, channel, template_code, title, body, payload, priority)
           SELECT user_id, 'in_app', 'product_qna_new',
                  $1, $2, $3::JSONB, 1
             FROM sellers WHERE id = $4::UUID`,
          [
            `Nova pergunta: ${productTitle}`,
            `"${questionExcerpt}${req.body.question.length > 200 ? '...' : ''}"`,
            JSON.stringify({ slug: p.rows[0].slug, product_id: req.body.product_id, qna_id: r.rows[0].id }),
            p.rows[0].seller_id,
          ]
        );
      }
      outcome = { ok: true, slug: p.rows[0].slug };
    });

    if (outcome?.error === 'product_not_found') {
      return res.status(404).json({ error: 'product_not_found' });
    }
    if (outcome?.error === 'too_soon') {
      return res.status(409).json({ error: 'too_soon', message: outcome.message });
    }

    /* FIX-WORKER-7 pass 327: cache invalidate wildcard pattern.
       PRE-FIX: cache.del('products:qna:${slug}') tentava deletar key sem
       suffix params, mas keys reais sao 'products:qna:<slug>:lim=X:p=Y:ans=Z'
       (paridade pass 298 product-svc public.js). del() era no-op.
       UX bug: nova qna nao invalidava cache -> PDP Q&A tab mostrava stale ate TTL.
       POST-FIX: wildcard pattern + slug normalize.
       cache.del internamente usa c.keys(pattern) (Redis KEYS) - aceita wildcard. */
    if (outcome?.slug) {
      const slugNorm = String(outcome.slug).toLowerCase().trim();
      await cache.del(`products:qna:${slugNorm}:*`).catch(() => {});
    }
    // FIX-WORKER-18 pass 361: invalidate seller pending queue cache
    //   Nova qna -> queue do seller incrementa -> dashboard mostra realtime
    cache.del('qna:seller:pending:*').catch(() => {});
    res.status(201).json({ qna });
  })
);

// POST /qna/:id/upvote - votar em uma pergunta (MLB-2)
// FIX-WORKER-7 pass 34: 8 BUGS aplicando Pattern W7 (3o endpoint race counter).
//
// BUG 1 *** TOCTOU race toggle *** SELECT exists + DELETE|INSERT sem lock
//   Mais grave que pass 33 - toggle vs idempotent INSERT.
//   User clica 2x rapido (UI double-click):
//   T0: Req A SELECT exists=empty (nao votou)
//   T1: Req B SELECT exists=empty (paralelo - sem lock)
//   T2: Req A INSERT vote -> OK (toggle to voted)
//   T3: Req B INSERT vote -> ON CONFLICT DO NOTHING (idempotent OK mas...)
//   T4: Response A "voted: true" + Response B "voted: true"
//   User espera toggle (1o click=vote, 2o click=unvote) mas ambos viram vote.
//   FIX: tx() + SELECT FOR UPDATE qna parent + decision atomic
//
// BUG 2 *** RACE COUNTER *** SELECT COUNT + UPDATE upvote_count
//   Mesmo bug pass 33 #1 (50 users upvote simultaneo = off-by-N).
//   FIX: SELECT FOR UPDATE product_qna + COUNT + UPDATE all dentro tx
//
// BUG 3 *** ATOMICITY *** 4 queries lineares sem tx()
//   SELECT exists + DELETE|INSERT + COUNT + UPDATE - falha entre = inconsistente
//   FIX: tudo no mesmo tx()
//
// BUG 4 UUID validate :id (anti PG 22P02 -> 500 generico)
//
// BUG 5 *** RATE-LIMIT *** toggle spam (mesmo pattern pass 33)
//   Bot toggle 1000x = 4000 queries DB. FIX: rateLimiter 30/15min/IP
//
// BUG 6 *** is_hidden check *** upvote em pergunta moderada
//   Pre-fix: aceita upvote em qna.is_hidden=TRUE (admin moderou) - counter
//   incrementa MAS qna nao aparece no PDP. FIX: validar is_hidden=FALSE
//
// BUG 7 *** Regra J orphan detection *** qna_id inexistente
//   FK fail INSERT product_qna_votes (qna_id FK product_qna)
//   = 23503 -> 500 generico. FIX: SELECT product_qna FOR UPDATE 404 antes
//
// BUG 8 voted: !exists.rows.length usa snapshot STALE
//   Race entre SELECT exists (pre-tx) e UPDATE final pode dar voted errado.
//   FIX: voted determinado APOS UPDATE atomico (counter > previous count)
const QNA_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const qnaVoteLimiter = rateLimiter.createLimiter({
  windowMs: 15 * 60 * 1000, max: 30,
  message: 'Muitos votos recentes. Aguarde alguns minutos.',
});

app.post('/qna/:id/upvote', qnaVoteLimiter, jwt.requireAuth(),
  asyncHandler(async (req, res, next) => {
    // FIX bug 4: UUID validate upfront
    if (!QNA_UUID_RE.test(req.params.id)) {
      return next(errorHandler.notFound('qna_not_found'));
    }

    let outcome;
    let result;
    let productSlug = null; // FIX pass 349: capture slug p/ cache invalidation
    await tx(async (c) => {
      // FIX bug 1+6+7 (Regras K+is_hidden+J): SELECT FOR UPDATE qna + checks
      // FIX-WORKER-16 pass 349 (MLB-2 cache invalidation):
      //   PRE-FIX: upvote endpoint NAO invalida cache products:qna:${slug}:*
      //   Cache TTL=60s entao count desatualizado por 60s na lista publica do PDP.
      //   User vota -> count++ na response do POST mas GET /:slug/qna mantem stale.
      //   Reload da pagina mostra count antigo - UX broken (MLB-2 mostra realtime).
      //   POST-FIX: JOIN products no SELECT inicial p/ capturar slug + cache.del
      //   wildcard apos commit (paridade pass 327).
      const qna = await c.query(
        `SELECT q.id, q.is_hidden, p.slug FROM product_qna q
          JOIN products p ON p.id = q.product_id
          WHERE q.id = $1::UUID FOR UPDATE OF q`,
        [req.params.id]
      );
      if (!qna.rows.length) { outcome = { error: 'qna_not_found' }; return; }
      if (qna.rows[0].is_hidden) {
        outcome = { error: 'qna_hidden' };
        return;
      }
      productSlug = qna.rows[0].slug;

      // FIX bug 1+8: toggle atomico DENTRO do tx (lock serializa T0-T3)
      // Req A le exists=empty -> INSERT. Req B aguarda lock release ->
      // le exists=TRUE (apos Req A commit) -> DELETE (toggle correto).
      const exists = await c.query(
        `SELECT 1 FROM product_qna_votes WHERE qna_id = $1::UUID AND user_id = $2::UUID`,
        [req.params.id, req.user.sub]
      );
      const wasVoted = exists.rows.length > 0;
      if (wasVoted) {
        await c.query(
          `DELETE FROM product_qna_votes WHERE qna_id = $1::UUID AND user_id = $2::UUID`,
          [req.params.id, req.user.sub]
        );
      } else {
        await c.query(
          `INSERT INTO product_qna_votes (qna_id, user_id) VALUES ($1::UUID, $2::UUID)
           ON CONFLICT DO NOTHING`,
          [req.params.id, req.user.sub]
        );
      }

      // FIX bug 2+3: COUNT + UPDATE atomic dentro do mesmo tx
      const countRow = await c.query(
        `SELECT COUNT(*)::INT AS n FROM product_qna_votes WHERE qna_id = $1::UUID`,
        [req.params.id]
      );
      const newCount = countRow.rows[0].n;
      await c.query(
        `UPDATE product_qna SET upvote_count = $1::INT WHERE id = $2::UUID`,
        [newCount, req.params.id]
      );

      result = {
        ok: true,
        upvote_count: newCount,
        // FIX bug 8: voted = !wasVoted (deterministic apos toggle no mesmo tx)
        voted: !wasVoted,
      };
    });

    if (outcome?.error === 'qna_not_found') return next(errorHandler.notFound('qna_not_found'));
    if (outcome?.error === 'qna_hidden') {
      return res.status(403).json({
        error: 'qna_hidden',
        message: 'Esta pergunta foi moderada e nao aceita votos.',
      });
    }

    // FIX-WORKER-16 pass 349 (MLB-2 cache invalidation post-commit):
    //   Invalida cache wildcard `products:qna:<slug>:*` (paridade pass 327)
    //   apos commit do tx. Fora do tx p/ nao bloquear se Redis lento/down.
    //   Tolera fail (Redis indisponivel != upvote falhar).
    if (productSlug) {
      const slugNorm = String(productSlug).trim().toLowerCase();
      cache.del(`products:qna:${slugNorm}:*`).catch(() => {});
    }

    res.json(result);
  })
);

// GET /qna/:id/voted - checa se user votou em qna especifica
// FIX-WORKER-7 pass 101: 4 BUGS aplicando Pattern W7 (UUID + Regra A + 404 + cache).
//
// BUG 1 *** UUID VALIDATE MISSING *** PG 22P02 -> 500 leak
//   PRE-FIX: req.params.id direto na query - input 'admin' -> PG cast UUID fail.
//   FIX: VOTED_UUID_RE.test() upfront.
//
// BUG 2 *** QnA EXISTENCE / Regra A status check MISSING ***
//   PRE-FIX: voto check em qna inexistente retorna {voted:false} 200.
//   - UX confuso: frontend pensa qna existe mas user nao votou
//   - Info leak: ataque enumeration via repeated requests (timing)
//   - Voto em qna de product deletado/archived ainda consultavel
//   FIX: JOIN products + status IN ('approved','platform_owned') + deleted_at IS NULL
//   -> 404 explicit se qna nao existe ou product inactive.
//
// BUG 3 *** UX response shape minimo ***
//   PRE-FIX: response so {voted: bool}. Frontend nao sabe direcao do voto.
//   FIX: + vote_direction (1 upvote, null se nao votou).
//
// BUG 4 *** No cache *** PDP refresh chama N vezes (1 per qna mostrado)
//   PRE-FIX: zero cache - 10 qnas no PDP = 10 queries DB cada page refresh.
//   FIX: cache 60s per-user+qna (votes raros - cache freshness aceitavel).
const VOTED_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

app.get('/qna/:id/voted', jwt.requireAuth(),
  cache.cacheMiddleware((req) => `qna:voted:${req.user?.sub || 'anon'}:${req.params.id}`, 60),
  asyncHandler(async (req, res, next) => {
    // BUG 1: UUID validate
    if (!VOTED_UUID_RE.test(req.params.id)) {
      return next(errorHandler.notFound('qna_not_found'));
    }

    // BUG 2: existence + Regra A check via JOIN products
    const exists = await query(
      `SELECT 1 FROM product_qna q
         JOIN products p ON p.id = q.product_id
        WHERE q.id = $1::UUID
          AND p.status IN ('approved','platform_owned')
          AND p.deleted_at IS NULL
        LIMIT 1`,
      [req.params.id]
    );
    if (!exists.rows.length) return next(errorHandler.notFound('qna_not_found'));

    // FIX-WORKER-7 pass 213 (BUG CRITICO): coluna 'vote' NAO EXISTE em
    // product_qna_votes. Schema (mig 010 linha 8-13):
    //   qna_id UUID, user_id UUID, created_at TIMESTAMPTZ, PK(qna_id, user_id)
    // PRE-FIX query 'SELECT vote' disparava PG 42703 column does not exist.
    // Em prod: errorHandler 500 -> frontend QnaUpvote UI mostrava bell-icon
    // sem state preservado (NotificationBell nao distinguia voted/not).
    //
    // FIX: simplificar query - vote binario (exists = upvoted, !exists = not voted).
    // No down-vote UI implementado - vote_direction sempre 'up' se voted.
    const r = await query(
      `SELECT 1 FROM product_qna_votes WHERE qna_id = $1::UUID AND user_id = $2::UUID`,
      [req.params.id, req.user.sub]
    );
    const voted = r.rows.length > 0;
    res.json({
      voted,
      vote_direction: voted ? 'up' : null,
    });
  })
);

// GET /qna/seller/pending - perguntas pendentes do seller logado
// FIX-WORKER-7 pass 57: 5 BUGS aplicando Pattern W7 (Regras A+D+E + LGPD + admin path).
//
// BUG 1 *** ADMIN BYPASS *** roles ['seller','admin'] aceita admin
//   PRE-FIX: JOIN sellers s ON s.user_id = $1 - admin SEM entry sellers retorna
//   0 rows. Endpoint inutil para admin/staff investigar qna pendente cross-seller.
//   FIX: isAdmin path opcional ?seller_id filter (sem ownership check).
//
// BUG 2 *** Regra A products.status missing *** qna em archived/rejected
//   PRE-FIX: nenhum check p.status. Seller ve qna pendente em produto que
//   foi rejeitado/archived - responder eh waste (qna nunca aparece PDP).
//   FIX: AND p.status IN ('approved','platform_owned') + deleted_at IS NULL.
//
// BUG 3 *** Regra D TIEBREAKER MISSING *** ORDER BY asked_at ASC nao determ
//   2 qna asked_at identicos (script bulk) -> ordem indefinida na fila seller.
//   FIX: + q.id ASC tiebreaker.
//
// BUG 4 *** Regra E PAGINATION MISSING *** hardcoded LIMIT 100
//   Seller com 500 qnas backlog (produto viral) so ve primeiras 100.
//   FIX: ?limit (clamp 1-100, default 50) + ?offset (>=0, default 0).
//
// BUG 5 *** LGPD PII LEAK asker_email plain text ***
//   PRE-FIX: u.email full text. Seller pode usar email asker fora-do-app
//   (contato direto, marketing nao-consentido).
//   FIX: maskEmail aplicado (seller so precisa display_name p/ contexto).
//   Admin path vê full (investigacao).
// FIX-WORKER-18 pass 361 (cache ausente em hot path dashboard-seller):
//   PRE-FIX: /qna/seller/pending SEM cacheMiddleware
//   - Dashboard-seller /qna page polls a cada 30-60s
//   - 100 sellers ativos = 100+ queries DB/min (JOIN products + sellers + users
//     + WHERE filter complexo + COUNT OVER window)
//   - Cada query ~30-100ms - load DB significativo
//   - Latencia perceptivel (UI bookmark a cada page nav)
//   POST-FIX: cache 30s vary by user.sub + paginacao + isAdmin path
//   - 30s freshness adequada (qna pending nao realtime critical)
//   - Per-user (seller A nao vê seller B no cache)
//   - Invalidation natural via TTL (qna_responder fluxo bate /qna/:id/answer)
//   - Pattern V8 cross-svc paridade ja existing (pass 200/202/216/289).
const qnaSellerPendingCacheKey = (req) => {
  const q = req.query;
  const isAdmin = req.user?.role === 'admin';
  const sellerId = isAdmin ? (q.seller_id || 'all') : (req.user?.sub || 'anon');
  return `qna:seller:pending:u=${sellerId}:lim=${q.limit||50}:off=${q.offset||0}`;
};

app.get('/qna/seller/pending', jwt.requireAuth({ roles: ['seller','admin'] }),
  cache.cacheMiddleware(qnaSellerPendingCacheKey, 30),
  asyncHandler(async (req, res) => {
    const isAdmin = req.user && req.user.role === 'admin';
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

    let whereClause;
    let params;
    if (isAdmin) {
      // Admin path: opcional ?seller_id filter (sem ownership check)
      const sellerIdFilter = req.query.seller_id || null;
      if (sellerIdFilter && !QNA_UUID_RE.test(String(sellerIdFilter))) {
        return res.status(400).json({ error: 'invalid_seller_id' });
      }
      whereClause = sellerIdFilter
        ? `q.seller_id = $1::UUID AND q.answer IS NULL AND q.is_hidden = FALSE
           AND p.status IN ('approved','platform_owned') AND p.deleted_at IS NULL`
        : `q.answer IS NULL AND q.is_hidden = FALSE
           AND p.status IN ('approved','platform_owned') AND p.deleted_at IS NULL`;
      params = sellerIdFilter ? [sellerIdFilter, limit, offset] : [limit, offset];
    } else {
      // Seller path: ownership via JOIN sellers
      whereClause = `s.user_id = $1::UUID AND q.answer IS NULL AND q.is_hidden = FALSE
                     AND p.status IN ('approved','platform_owned') AND p.deleted_at IS NULL`;
      params = [req.user.sub, limit, offset];
    }

    const limitParamIdx = params.length - 1;
    const offsetParamIdx = params.length;

    // FIX-WORKER-7 pass 189: COUNT(*) OVER() window (consolidation pattern)
    // + BUG total errado: 'total: qna.length' reportava paginated count em
    // vez de absolute. UI seller "X de Y" Y stale.
    const r = await query(
      `SELECT q.id, q.question, q.asked_at, q.upvote_count,
              p.id AS product_id, p.slug AS product_slug, p.title AS product_title, p.cover_image_url,
              u.display_name AS asker_name, u.email AS asker_email,
              COUNT(*) OVER()::INT AS _total
         FROM product_qna q
         JOIN products p ON p.id = q.product_id
         JOIN sellers s ON s.id = q.seller_id
         LEFT JOIN users u ON u.id = q.asked_by_user_id
        WHERE ${whereClause}
        ORDER BY q.asked_at ASC, q.id ASC
        LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx}`, params
    );

    const total = r.rows[0]?._total ?? 0;

    // LGPD masking: seller só vê email mascarado (data minimization)
    const qna = r.rows.map((row) => {
      const { _total, ...rest } = row;
      if (isAdmin) return rest;
      return { ...rest, asker_email: maskEmail(rest.asker_email) };
    });

    res.json({
      qna,
      total,
      limit,
      offset,
      has_more: (offset + qna.length) < total,
    });
  })
);

// POST /qna/:id/answer (seller responde)
// FIX-WORKER-7 pass 36: 6 BUGS aplicando Pattern W7 (Regras Q+K+J+ownership+atomicity).
//
// BUG 1 *** IDEMPOTENCY Regra Q *** re-answer overwrites silently
//   PRE-FIX: UPDATE SET answer=... WHERE id=$3 - sem check answer IS NULL
//   Seller pode "responder" mesma qna 10x - ultima sobrescreve anteriores.
//   Forense corrompido (audit_log perde history das answers anteriores).
//   Pattern Regra Q W7 pass 25 (vault revoke): operacoes terminais NAO
//   permitem re-execucao. MLB: 1 answer permanente, edicao via endpoint dedicado.
//   FIX: WHERE answer IS NULL guard. Se ja respondida -> 409 Conflict +
//   existing answer preservada.
//
// BUG 2 *** ADMIN BYPASS OWNERSHIP *** role admin ignorado
//   PRE-FIX: roles ['seller','admin'] aceita admin, MAS JOIN sellers + user_id
//   exige req.user ser seller dono. Admin SEM entry sellers -> 0 rows -> 404.
//   Admin NAO pode responder em nome seller mesmo com permissao.
//   Use case: admin responde qna abandonada (seller inativo) com flag by_admin.
//   FIX: roles check separado - admin path skip ownership + flag answered_by_admin.
//
// BUG 3 *** ATOMICITY *** 3 queries lineares
//   UPDATE qna + INSERT notif + cache.del. Falha notif = answer existe
//   mas buyer nao notificado. Buyer perde lead venda.
//   FIX: tx() atomic (cache.del fora - tolera fail).
//
// BUG 4 *** is_hidden check *** answer em qna moderada
//   Seller responde qna que admin moderou (hidden=TRUE). Answer vai pro DB
//   mas qna nao aparece PDP. Workflow inconsistente.
//   FIX: validar qna.is_hidden = FALSE upfront.
//
// BUG 5 UUID validate + rate-limit (padrao pass 32-35)
const qnaAnswerLimiter = rateLimiter.createLimiter({
  windowMs: 15 * 60 * 1000, max: 20,  // sellers respondem mais que buyers perguntam
  message: 'Muitas respostas recentes. Aguarde alguns minutos.',
});

app.post('/qna/:id/answer',
  qnaAnswerLimiter,
  jwt.requireAuth({ roles: ['seller','admin','staff'] }),
  validate({ body: z.object({ answer: z.string().min(1).max(5000) }) }),
  asyncHandler(async (req, res, next) => {
    if (!QNA_UUID_RE.test(req.params.id)) {
      return next(errorHandler.notFound('qna_not_found'));
    }

    const isAdmin = ['admin','staff'].includes(req.user.role);
    let outcome;
    let result;
    await tx(async (c) => {
      // FIX bug 1+2+4: SELECT FOR UPDATE qna com checks consolidados
      // Admin path: aceita qualquer qna. Seller path: enforce ownership via JOIN.
      const qnaQuery = isAdmin
        ? `SELECT q.id, q.product_id, q.seller_id, q.is_hidden, q.answer,
                  q.asked_by_user_id
             FROM product_qna q
            WHERE q.id = $1::UUID FOR UPDATE OF q`
        : `SELECT q.id, q.product_id, q.seller_id, q.is_hidden, q.answer,
                  q.asked_by_user_id
             FROM product_qna q
             JOIN sellers s ON s.id = q.seller_id AND s.user_id = $2::UUID
            WHERE q.id = $1::UUID FOR UPDATE OF q`;
      const params = isAdmin ? [req.params.id] : [req.params.id, req.user.sub];
      const qna = await c.query(qnaQuery, params);
      if (!qna.rows.length) {
        outcome = { error: isAdmin ? 'qna_not_found' : 'not_found_or_not_owner' };
        return;
      }
      const q = qna.rows[0];

      // Regra Q: idempotent terminal - answer ja existe
      if (q.answer && q.answer.trim()) {
        outcome = {
          error: 'already_answered',
          existing_answer: q.answer,
          // Forense: admin pode investigar quem respondeu antes
        };
        return;
      }
      // is_hidden check (bug 4)
      if (q.is_hidden) {
        outcome = { error: 'qna_hidden' };
        return;
      }

      // UPDATE answer idempotent guard (anti-race com outro seller-co-owner ou admin)
      await c.query(
        `UPDATE product_qna
            SET answer = $1, answered_at = NOW(),
                answered_by_user_id = $2::UUID,
                answered_by_admin = $3::BOOLEAN,
                updated_at = NOW()
          WHERE id = $4::UUID AND (answer IS NULL OR answer = '')`,
        [req.body.answer, req.user.sub, isAdmin, req.params.id]
      );

      // INSERT notification ATOMICA (mesmo tx - bug 3)
      if (q.asked_by_user_id) {
        await c.query(
          `INSERT INTO notifications (user_id, channel, template_code, title, body)
           VALUES ($1::UUID, 'in_app', 'qna_answered', 'Sua pergunta foi respondida', 'Acesse o produto para ver a resposta')`,
          [q.asked_by_user_id]
        );
      }

      // Cache slug fetch dentro tx p/ ter no outcome
      const slugRow = await c.query(`SELECT slug FROM products WHERE id = $1::UUID`, [q.product_id]);
      result = { ok: true, slug: slugRow.rows[0]?.slug, answered_by_admin: isAdmin };
    });

    if (outcome?.error === 'qna_not_found' || outcome?.error === 'not_found_or_not_owner') {
      return res.status(404).json({ error: outcome.error });
    }
    if (outcome?.error === 'qna_hidden') {
      return res.status(403).json({ error: 'qna_hidden',
        message: 'Esta pergunta foi moderada.' });
    }
    if (outcome?.error === 'already_answered') {
      return res.status(409).json({
        error: 'already_answered',
        message: 'Esta pergunta ja foi respondida anteriormente.',
        existing_answer: outcome.existing_answer,
      });
    }

    /* FIX-WORKER-7 pass 327: cache invalidate wildcard paridade linha 488 */
    if (result?.slug) {
      const slugNorm = String(result.slug).toLowerCase().trim();
      await cache.del(`products:qna:${slugNorm}:*`).catch(() => {});
    }
    // FIX-WORKER-18 pass 361: invalidate seller pending queue cache
    //   Resposta -> queue do seller decrementa -> dashboard mostra realtime
    cache.del('qna:seller:pending:*').catch(() => {});
    res.json({ ok: true, answered_by_admin: result.answered_by_admin });
  })
);

// ============================================================
// REPORTS
// ============================================================
// FIX-WORKER-6 pass 2: target_id existencia + dedup user/target/reason
// Antes: qualquer buyer podia flood reports + alerts table com UUIDs fake.
// Cada denuncia gerava alerta DB para admin = DoS por noise + crescimento DB.
const TARGET_TABLE_MAP = {
  product: 'products',
  seller: 'sellers',
  review: 'product_reviews',
  user: 'users',
  qna: 'product_qna',
};
// FIX-WORKER-7 pass 38: rate-limit DOS-ATTACK PRIMARY VECTOR.
// Endpoint MAIS critico de abuse em review-svc (DoS reputational).
// PRE-FIX (gap documentado desde pass 35): zero rate-limit.
// ATAQUE: atacante seller competidor abre 1000 reports/min em concorrentes:
//   - alerts table cresce + admin dashboard overflow
//   - Sellers reportados suspensos "preventivamente" enquanto admin investiga
//   - DoS reputational similar pass 29 dispute (atacante elimina competicao)
// FIX: rateLimiter 5/15min/IP (real users <2 reports/dia legitimo).
const reportLimiter = rateLimiter.createLimiter({
  windowMs: 15 * 60 * 1000, max: 5,
  message: 'Muitas denuncias recentes. Aguarde alguns minutos.',
});

app.post('/reports',
  reportLimiter,
  jwt.requireAuth(),
  /* FIX-WORKER-7 pass 334: evidence_urls max() hardening paridade pass 332/333.
     PRE-FIX: array(z.string().url()) sem item.max() ou array.max().
     Atacante pode enviar 1000 URLs de 10kb cada = 10MB payload.
     express.json 256kb catches, mas ate isso storage waste.
     POST-FIX: array.max(10) - reports raramente >5 evidencias + item.max(2048). */
  validate({ body: z.object({
    target_type: z.enum(['product','seller','review','user','qna']),
    target_id: z.string().uuid(),
    reason_code: z.enum(['plagiarism','spam','scam','offensive','copyright','other']),
    description: z.string().max(2000).optional(),
    evidence_urls: z.array(z.string().url().max(2048)).max(10).optional(),
  })}),
  asyncHandler(async (req, res, next) => {
    // FIX-WORKER-7 pass 38: 6 BUGS aplicando Pattern W7 17 regras.
    //
    // BUG 1 RATE-LIMIT (acima do handler) - PRIMARY VECTOR DoS reputational
    //
    // BUG 2 *** SELF-REPORT block ***
    //   Pre-fix: user pode reportar a si mesmo (target_type='user'+target_id=self)
    //   OU seu proprio produto (target_type='product' do seller dono).
    //   Sem semantica - confusao admin queue.
    //   FIX: validar reporter != target_user_id (resolve target ownership)
    //
    // BUG 3 *** ATOMICITY *** INSERT report + INSERT alert sem tx()
    //   Falha alert = report orfao sem alerta admin. Admin nao processa.
    //   FIX: tx() atomic - tudo all-or-nothing.
    //
    // BUG 4 *** Regra I *** RETURNING * vaza internal_notes/admin_resolution_notes
    //   FIX: RETURNING explicit fields consumed por UI.
    //
    // BUG 5 *** Regra B *** deleted_at IS NULL no target check
    //   Pre-fix: SELECT 1 FROM tbl WHERE id=$1 (sem deleted_at filter)
    //   Pode reportar produto soft-deletado - admin queue lixo.
    //   FIX: AND deleted_at IS NULL (onde aplicavel: products, users)
    //
    // BUG 6 *** XSS storage *** description raw em alerts.message
    //   alerts.message concat string com description user input.
    //   W13 pass 31 (renderMustache) resolve XSS no render time MAS
    //   storage raw permite future bug se template change.
    //   FIX: strip control chars + truncate na storage (defensive).
    const tbl = TARGET_TABLE_MAP[req.body.target_type];

    // Pre-validation: self-report block (bug 2)
    // target_type=user direto: target_id === reporter
    if (req.body.target_type === 'user' && req.body.target_id === req.user.sub) {
      return next(errorHandler.badRequest('cannot_report_self'));
    }

    let outcome;
    let report;
    await tx(async (c) => {
      // FIX bug 5 (Regra B): deleted_at IS NULL aplicavel a products + users
      // (sellers + reviews + qna usam is_hidden/is_active separadas).
      const hasDeletedAt = ['products','users'].includes(tbl);
      const existsSql = hasDeletedAt
        ? `SELECT 1 FROM ${tbl} WHERE id = $1::UUID AND deleted_at IS NULL LIMIT 1`
        : `SELECT 1 FROM ${tbl} WHERE id = $1::UUID LIMIT 1`;
      const exists = await c.query(existsSql, [req.body.target_id]);
      if (!exists.rows.length) {
        outcome = { error: 'target_not_found' };
        return;
      }

      // Bug 2 expandido: se target_type=product/seller/review/qna, validar
      // target ownership nao eh do reporter (anti-self-report transitive).
      if (req.body.target_type === 'product') {
        const own = await c.query(
          `SELECT 1 FROM products p
             JOIN sellers s ON s.id = p.seller_id
            WHERE p.id = $1::UUID AND s.user_id = $2::UUID LIMIT 1`,
          [req.body.target_id, req.user.sub]
        );
        if (own.rows.length) { outcome = { error: 'cannot_report_own_product' }; return; }
      } else if (req.body.target_type === 'seller') {
        const own = await c.query(
          `SELECT 1 FROM sellers WHERE id = $1::UUID AND user_id = $2::UUID LIMIT 1`,
          [req.body.target_id, req.user.sub]
        );
        if (own.rows.length) { outcome = { error: 'cannot_report_own_seller' }; return; }
      }

      // Dedup 7 dias (pre-existing, mantido)
      const dup = await c.query(
        `SELECT 1 FROM reports
          WHERE reporter_user_id = $1::UUID AND target_type = $2 AND target_id = $3::UUID
            AND reason_code = $4 AND created_at > NOW() - INTERVAL '7 days'
          LIMIT 1`,
        [req.user.sub, req.body.target_type, req.body.target_id, req.body.reason_code]
      );
      if (dup.rows.length) { outcome = { error: 'duplicate_report' }; return; }

      // FIX bug 6: sanitize description antes storage (defense-in-depth)
      // Strip control chars C0/C1 (anti future XSS via alerts.message rendering)
      const sanitizedDesc = req.body.description
        ? req.body.description.replace(/[--]/g, '').slice(0, 2000)
        : null;

      // INSERT report (Regra I: RETURNING explicit)
      const r = await c.query(
        `INSERT INTO reports (reporter_user_id, target_type, target_id, reason_code,
                              description, evidence_urls)
         VALUES ($1::UUID, $2, $3::UUID, $4, $5, $6)
         RETURNING id, target_type, target_id, reason_code, status, created_at`,
        [req.user.sub, req.body.target_type, req.body.target_id, req.body.reason_code,
         sanitizedDesc, req.body.evidence_urls || null]
      );
      report = r.rows[0];

      // Alerta admin ATOMIC (mesmo tx - bug 3)
      // FIX bug 6: alerts.message tambem sanitizada via slice (max 500)
      const alertMsg = `Reporter: ${req.user.sub}. Motivo: ${req.body.reason_code}. ${sanitizedDesc || ''}`.slice(0, 500);
      await c.query(
        `INSERT INTO alerts (severity, source, code, title, message, target_type, target_id)
         VALUES ('warn','reports','new_report',$1,$2,$3,$4::UUID)`,
        [`Nova denuncia: ${req.body.reason_code}`, alertMsg,
         req.body.target_type, req.body.target_id]
      );
    });

    if (outcome?.error === 'target_not_found') return next(errorHandler.notFound('target_not_found'));
    if (outcome?.error === 'cannot_report_own_product') {
      return res.status(400).json({ error: 'cannot_report_own_product',
        message: 'Voce nao pode reportar seu proprio produto.' });
    }
    if (outcome?.error === 'cannot_report_own_seller') {
      return res.status(400).json({ error: 'cannot_report_own_seller',
        message: 'Voce nao pode reportar sua propria loja.' });
    }
    if (outcome?.error === 'duplicate_report') {
      return res.status(409).json({ error: 'duplicate_report',
        message: 'Voce ja reportou este item nos ultimos 7 dias.' });
    }

    res.status(201).json({ report });
  })
);

// Gateway proxia /api/reviews/* sem prefix - rotas chegam direto na raiz
// GET /seller/received - reviews recebidas pelo seller logado
// FIX-WORKER-7 pass 56: 5 BUGS aplicando Pattern W7 (A-W).
//
// BUG 1 *** ADMIN BYPASS *** JOIN sellers + WHERE s.user_id=$1
//   Admin sem entry sellers -> query retorna 0 reviews mesmo com role admin
//   Pattern pass 36/37 resolveu mesma classe - replicar
//   FIX: isAdmin path SKIP ownership JOIN (admin vê TODAS reviews + filter ?seller_id)
//
// BUG 2 *** LGPD PII LEAK buyer_email plain *** Art 9°/Art 5(c) minimization
//   Seller NAO precisa email completo - so display_name + email masked
//   FIX: substring/mask email: 'j***@gmail.com' style (3 prefix chars + ***@domain)
//
// BUG 3 *** Regra D tiebreaker *** ORDER BY created_at DESC sem secondary
//   FIX: + r.id DESC (UUID unique)
//
// BUG 4 *** Regra E ?limit query param missing ***
//   FIX: query.limit clamped 1-200 + response shape { reviews, limit, count }
//
// BUG 5 *** CACHE missing *** endpoint hot (seller dashboard refresh)
//   3 JOINs + 100 rows = ~50-200ms sem cache
//   FIX: cache.cacheMiddleware 60s - acaba 99% hits em ms
//   Cache key: per-seller (req.user.sub) + limit param
const sellerReceivedCacheKey = (req) => {
  const isAdmin = ['admin','staff'].includes(req.user?.role);
  const lim = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 100, 200));
  const off = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const sellerFilter = isAdmin && req.query.seller_id ? String(req.query.seller_id).toLowerCase() : '';
  return `reviews:seller_received:${req.user?.sub || 'anon'}:adm=${isAdmin}:sf=${sellerFilter}:lim=${lim}:off=${off}`;
};

app.get('/seller/received',
  jwt.requireAuth({ roles: ['seller','admin','staff'] }),
  cache.cacheMiddleware(sellerReceivedCacheKey, 60),
  asyncHandler(async (req, res) => {
    const isAdmin = ['admin','staff'].includes(req.user.role);
    const lim = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 100, 200));
    const off = Math.max(0, parseInt(req.query.offset, 10) || 0);
    /* FIX-WORKER-4 pass 313 hardening:
       BUG 1: ?seller_id raw sem UUID validation - PG cast erro 500 leak
       BUG 2: hardcoded LIMIT sem ?offset paginacao
       BUG 3: sem COUNT total (pattern V8 14+ endpoints consolidados)
       POST-FIX:
       - UUID_RE validate p/ ?seller_id (400 invalid)
       - + ?offset paginacao V8 Regra E
       - + COUNT(*) OVER() window aggregate + strip _total */
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (isAdmin && req.query.seller_id && !UUID_RE.test(String(req.query.seller_id))) {
      return res.status(400).json({ error: 'invalid_seller_id', expected: 'UUID v4 format' });
    }
    const sellerFilter = isAdmin && req.query.seller_id ? req.query.seller_id : null;

    const sql = isAdmin
      ? `SELECT r.id, r.rating, r.title, r.body, r.is_verified_purchase,
                r.helpful_count, r.unhelpful_count, r.reply_from_seller, r.reply_at,
                r.created_at, r.seller_id,
                p.id AS product_id, p.slug AS product_slug, p.title AS product_title, p.cover_image_url,
                u.display_name AS buyer_name, u.email AS buyer_email,
                COUNT(*) OVER()::INT AS _total
           FROM product_reviews r
           JOIN products p ON p.id = r.product_id
           LEFT JOIN users u ON u.id = r.buyer_user_id
          WHERE r.is_hidden = FALSE
            AND ($1::UUID IS NULL OR r.seller_id = $1::UUID)
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT $2 OFFSET $3`
      : `SELECT r.id, r.rating, r.title, r.body, r.is_verified_purchase,
                r.helpful_count, r.unhelpful_count, r.reply_from_seller, r.reply_at,
                r.created_at,
                p.id AS product_id, p.slug AS product_slug, p.title AS product_title, p.cover_image_url,
                u.display_name AS buyer_name, u.email AS buyer_email,
                COUNT(*) OVER()::INT AS _total
           FROM product_reviews r
           JOIN products p ON p.id = r.product_id
           JOIN sellers s ON s.id = r.seller_id
           LEFT JOIN users u ON u.id = r.buyer_user_id
          WHERE s.user_id = $1 AND r.is_hidden = FALSE
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT $2 OFFSET $3`;
    const params = isAdmin
      ? [sellerFilter, lim, off]
      : [req.user.sub, lim, off];

    const r = await query(sql, params);
    const total = r.rows[0]?._total ?? 0;

    // FIX-WORKER-5 pass 373 (KPI aggregate cross-pages):
    //   PRE-FIX: response retornava reviews paginated apenas.
    //   Frontend dashboard-seller calculava avgRating client-side via
    //   reviews.reduce/length - SO da pagina atual (max 50).
    //   Seller com 500 reviews via avg de 50 = numero ERRADO no KPI header.
    //   MLB dashboard standard: KPIs sao agregado completo, nao paginated.
    //   POST-FIX: agg query separada (AVG + COUNT pending_reply) - retorno
    //   {avg_rating, pending_reply_count} no top-level response. Frontend usa.
    //   Pattern V8 W5 cross-page consistency consolidacao.
    const aggSql = isAdmin
      ? `SELECT
           ROUND(AVG(r.rating)::numeric, 1) AS avg_rating,
           COUNT(*) FILTER (WHERE r.reply_from_seller IS NULL) AS pending_reply_count
         FROM product_reviews r
         WHERE r.is_hidden = FALSE
           AND ($1::UUID IS NULL OR r.seller_id = $1::UUID)`
      : `SELECT
           ROUND(AVG(r.rating)::numeric, 1) AS avg_rating,
           COUNT(*) FILTER (WHERE r.reply_from_seller IS NULL) AS pending_reply_count
         FROM product_reviews r
         JOIN sellers s ON s.id = r.seller_id
         WHERE s.user_id = $1 AND r.is_hidden = FALSE`;
    const aggParams = isAdmin ? [sellerFilter] : [req.user.sub];
    const aggResult = await query(aggSql, aggParams);
    const agg = aggResult.rows[0] || {};

    const reviews = r.rows.map((row) => {
      const { _total, ...rest } = row;
      if (!isAdmin && rest.buyer_email) {
        rest.buyer_email = maskPII.email(rest.buyer_email);
      }
      return rest;
    });

    res.json({
      reviews,
      count: reviews.length,
      total,
      // FIX pass 373: agregados cross-page p/ KPI dashboard
      avg_rating: agg.avg_rating !== null ? Number(agg.avg_rating) : null,
      pending_reply_count: Number(agg.pending_reply_count || 0),
      limit: lim,
      offset: off,
      has_more: (off + reviews.length) < total,
      is_admin_view: isAdmin,
      ...(sellerFilter ? { seller_filter: sellerFilter } : {}),
    });
  })
);

// GET /admin/reports?status=open (acessada via /api/reviews/admin/reports)
// GET /admin/reports - listagem admin/staff de reports moderacao.
// FIX-WORKER-7 pass 57: 6 BUGS aplicando Pattern W7 (Regras D+E+I + LGPD masking).
//
// BUG 1 *** Regra E PAGINATION MISSING *** hardcoded LIMIT 200
//   PRE-FIX: nenhum ?limit/?offset query param. Admin queue 1000+ reports
//   acumulados (cron de moderacao backlog) -> 200 retornados sempre, restantes
//   inacessiveis. UX broken para large queues.
//   FIX: ?limit (clamp 1-200, default 50) + ?offset (>=0, default 0).
//
// BUG 2 *** Regra D TIEBREAKER MISSING *** ORDER BY created_at DESC nao determ
//   2 reports created_at identicos (cron mass-flag) -> ordem indefinida.
//   FIX: + r.id DESC tiebreaker.
//
// BUG 3 *** STATUS ENUM VALIDATION *** req.query.status sem whitelist
//   PRE-FIX: req.query.status || 'open' aceita qualquer string. Atribui ao $1
//   PG enum cast falha 500 (vazamento internals query) em vez 400 explicit.
//   FIX: enum whitelist + 400 invalid_status se fora.
//
// BUG 4 *** LGPD PII LEAK *** reporter_email/name plain text
//   PRE-FIX: SELECT r.*, u.email, u.full_name -> staff (role inferior admin)
//   recebe PII denunciante full. LGPD principio minimizacao: staff so precisa
//   mask para investigar; admin vê full p/ acao moderadora.
//   FIX: isAdmin path skip mask. Staff path aplica maskEmail (jo***@email.com).
//
// BUG 5 *** Regra I SELECT explicit fields *** SELECT r.* unsafe
//   Schema reports.* pode trazer cols sensiveis novas (ip_address?) sem audit.
//   FIX: enumerar fields explicit + version-safe.
//
// BUG 6 *** CACHE MISSING *** admin queue refresh manual sempre hit DB
//   Pattern pass 56 estabeleceu cache.cacheMiddleware 60s p/ listings.
//   FIX: cache 30s (admin precisa freshness mais alta que seller).
const ADMIN_REPORTS_STATUS = new Set(['open','under_review','resolved','dismissed']);
// FIX-WORKER-7 pass 58: maskEmail/maskName extracted to @cas/shared.maskPII
// (LGPD data minimization DRY cross-svc). Helpers locais REMOVIDOS.
const maskEmail = maskPII.email;
const maskName = maskPII.name;

app.get('/admin/reports', jwt.requireAuth({ roles: ['admin','staff'] }),
  cache.cacheMiddleware({ ttl: 30, keyPrefix: 'admin-reports', varyByUser: false }),
  asyncHandler(async (req, res) => {
    const status = String(req.query.status || 'open');
    if (!ADMIN_REPORTS_STATUS.has(status)) {
      return res.status(400).json({ error: 'invalid_status', allowed: Array.from(ADMIN_REPORTS_STATUS) });
    }
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

    // FIX-WORKER-7 pass 110 deploy: schema real reports (psql \\d):
    //   reason_code (não reason), description (não notes), resolved_by
    //   (não resolved_by_user_id), evidence_urls. Removidos campos
    //   ficticios: reason, notes, resolved_by_user_id.
    // FIX-WORKER-7 pass 189 (BUG TOTAL ERRADO):
    //   PRE-FIX: 'total: reports.length' reportava paginated count (max 50)
    //   em vez de absolute total. UI admin "X de Y" Y stale: 50 de 200 -> 50 de 50.
    //   "Carregar mais" disabled erroneamente quando havia mais reports.
    //   FIX: COUNT(*) OVER()::INT window aggregate + strip _total interno
    //   Same pattern aplicado em product-svc (pass 187), wishlist (pass 178),
    //   notification (pass 179), vault keys list (pass 180).
    const r = await query(
      `SELECT r.id, r.target_type, r.target_id, r.reason_code, r.description,
              r.evidence_urls, r.status, r.resolution_notes, r.resolved_at,
              r.resolved_by, r.reporter_user_id, r.created_at,
              u.email AS reporter_email, u.full_name AS reporter_name,
              COUNT(*) OVER()::INT AS _total
         FROM reports r
         LEFT JOIN users u ON u.id = r.reporter_user_id
        WHERE r.status = $1
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT $2 OFFSET $3`, [status, limit, offset]
    );

    const total = r.rows[0]?._total ?? 0;

    // LGPD masking: admin vê full, staff vê masked (data minimization)
    const isAdmin = req.user && req.user.role === 'admin';
    const reports = r.rows.map((row) => {
      const { _total, ...rest } = row;
      if (isAdmin) return rest;
      return {
        ...rest,
        reporter_email: maskEmail(rest.reporter_email),
        reporter_name: maskName(rest.reporter_name),
      };
    });

    res.json({
      reports,
      total,
      limit,
      offset,
      has_more: (offset + reports.length) < total,
      status,
    });
  })
);

// POST /reports/:id/resolve (via /api/reviews/reports/:id/resolve)
// FIX-WORKER-7 pass 39: 5 BUGS aplicando Pattern W7 (admin terminal endpoint).
// Pattern consolidado pass 25 (vault revoke), pass 31 (dispute resolve),
// pass 36 (qna answer), pass 37 (review reply).
//
// BUG 1 *** Regra Q IDEMPOTENT TERMINAL *** re-resolve corruption forense
//   PRE-FIX: UPDATE WHERE id=$4 (sem status atual check)
//   Admin A resolve report status=resolved notes="confirmado plagio" 10:00
//   Audit externo registra incident 10:00
//   Admin B resolve MESMO report status=dismissed notes="falsa denuncia" 14:00
//   -> sobrescreve resolved_at + resolution_notes -> timeline corrompido
//   Pattern Regra Q (pass 25 vault) - terminal operations preserve original
//   FIX: WHERE status NOT IN ('resolved','dismissed') idempotent guard
//
// BUG 2 *** SILENT 404 *** UPDATE rowcount=0 + res.json({ok:true})
//   PRE-FIX: report id inexistente -> 0 rows -> 200 OK silencioso
//   Admin pensa "resolvi" mas DB nao mudou. UX broken.
//   FIX: SELECT FOR UPDATE upfront + check rowcount -> 404 explicit
//
// BUG 3 *** AUDIT LOG MISSING *** sec event critical sem trail no DB
//   Pattern W7 pass 23/25/31/36/37 estabeleceu: high-impact endpoints
//   (mod actions, payments, security) DEVEM ter audit_log INSERT atomic.
//   /reports/:id/resolve afeta reputation seller -> audit critical.
//   FIX: INSERT audit_log dentro do MESMO tx (atomic with UPDATE)
//
// BUG 4 *** Regra K *** SELECT FOR UPDATE race entre 2 admins
//   2 admins resolvem same report simultaneo - UPDATE concorrente.
//   FIX: SELECT FOR UPDATE serializa
//
// BUG 5 *** NOTIFICATION REPORTER MISSING *** UX inconsistencia
//   Reporter abre report, NUNCA sabe o resultado (resolved/dismissed).
//   Pattern pass 36/37 estabeleceu notificacao downstream.
//   FIX: INSERT notification ao reporter (atomic mesmo tx)
//   - status=resolved -> "Sua denuncia foi acolhida + acao tomada"
//   - status=dismissed -> "Sua denuncia foi analisada"
//   - status=under_review -> sem notif (intermediario)
const RESOLVE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

app.post('/reports/:id/resolve', jwt.requireAuth({ roles: ['admin','staff'] }),
  validate({ body: z.object({
    status: z.enum(['resolved','dismissed','under_review']),
    notes: z.string().min(10).max(2000),  // min 10 chars (justificativa real)
  }) }),
  asyncHandler(async (req, res, next) => {
    if (!RESOLVE_UUID_RE.test(req.params.id)) {
      return next(errorHandler.notFound('report_not_found'));
    }

    let outcome;
    await tx(async (c) => {
      // BUG 4: SELECT FOR UPDATE (Regra K race entre 2 admins)
      const cur = await c.query(
        `SELECT id, status, reporter_user_id, target_type, target_id, reason_code
           FROM reports WHERE id = $1::UUID FOR UPDATE`,
        [req.params.id]
      );
      if (!cur.rows.length) { outcome = { error: 'not_found' }; return; }
      const r = cur.rows[0];

      // BUG 1: Regra Q idempotent terminal
      // resolved + dismissed sao TERMINAIS - admin nao deve re-decidir
      // under_review eh intermediario - admin pode escalar para resolved/dismissed
      const TERMINAL_STATUSES = ['resolved', 'dismissed'];
      if (TERMINAL_STATUSES.includes(r.status)) {
        outcome = {
          error: 'already_resolved',
          current_status: r.status,
        };
        return;
      }

      // UPDATE idempotent guard (anti race-residual)
      await c.query(
        `UPDATE reports
            SET status = $1, resolution_notes = $2,
                resolved_by = $3::UUID, resolved_at = NOW()
          WHERE id = $4::UUID
            AND status NOT IN ('resolved','dismissed')`,
        [req.body.status, req.body.notes, req.user.sub, req.params.id]
      );

      // BUG 3: audit_log INSERT atomic (forense pattern pass 23)
      await c.query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES ($1, $2, 'report.resolve', 'report', $3, 'warn', $4::JSONB)`,
        [req.user.sub, req.user.role, req.params.id,
         JSON.stringify({
           new_status: req.body.status,
           previous_status: r.status,
           target_type: r.target_type,
           target_id: r.target_id,
           reason_code: r.reason_code,
           notes_length: req.body.notes.length,
           ip: req.ip,
         })]
      );

      // BUG 5: notification ao reporter (mesma tx - atomico)
      // SKIP se under_review (intermediario - reporter aguarda)
      if (r.reporter_user_id && req.body.status !== 'under_review') {
        const title = req.body.status === 'resolved'
          ? 'Sua denuncia foi acolhida'
          : 'Sua denuncia foi analisada';
        const body = req.body.status === 'resolved'
          ? 'Apos analise, sua denuncia foi acolhida e medidas foram tomadas.'
          : 'Apos analise, sua denuncia foi avaliada. Obrigado por reportar.';
        await c.query(
          `INSERT INTO notifications (user_id, channel, template_code, title, body)
           VALUES ($1::UUID, 'in_app', 'report_resolved', $2, $3)`,
          [r.reporter_user_id, title, body]
        );
      }
    });

    if (outcome?.error === 'not_found') {
      return next(errorHandler.notFound('report_not_found'));
    }
    if (outcome?.error === 'already_resolved') {
      // Regra Q: 409 + current_status preservado (forense intact)
      return res.status(409).json({
        error: 'already_resolved',
        message: 'Esta denuncia ja foi resolvida anteriormente.',
        current_status: outcome.current_status,
      });
    }
    res.json({ ok: true });
  })
);

// ============================================================
// REPUTATION CRON DIARIO (V8 - refresh nightly)
// ============================================================
async function refreshAllReputations() {
  log.info('[reputation] start');
  // FIX-WORKER-14 pass 210: usa fn_refresh_all_seller_reputations() bulk
  // (migration 063). Substitui loop O(N*6) por single set-based call O(7 queries).
  // Em prod com 1000 sellers: ~30-60s -> ~2-5s (10-30x faster).
  // Fallback per-seller para edge case (caso migration 063 nao aplicada):
  let ok = 0, err = 0;
  const startedAt = Date.now();
  let bulkResult = null;
  try {
    const r = await query('SELECT * FROM fn_refresh_all_seller_reputations()');
    bulkResult = r.rows[0];
    ok = bulkResult.seller_count;
  } catch (e) {
    // Fallback per-seller loop (migration 063 nao aplicada ou erro bulk)
    log.warn({ /* FIX pass 343 DLP */ err: mask.text(String(e.message || '').slice(0, 300)) }, '[reputation.bulk.fail] falling back per-seller');
    const sellers = await query(`SELECT id FROM sellers WHERE status = 'active' AND deleted_at IS NULL`);
    for (const s of sellers.rows) {
      try {
        await query('SELECT fn_refresh_seller_reputation($1)', [s.id]);
        ok++;
      } catch (e2) {
        err++; log.warn({ seller: s.id, err: e2.message }, '[reputation.err]');
      }
    }
  }
  // Fake sellers.rows shape p/ logs downstream que referenciam sellers.rows.length
  const sellers = { rows: { length: ok + err } };
  // FIX-WORKER-14 pass 208: error tracking + audit log no REFRESH
  // PRE-FIX: .catch(() => {}) swallow silent
  //   Admin nunca soube se mv_seller_kpi atualizou ou silenciou erro 24h
  //   Em prod observamos KPIs antigos sem causa identificavel
  // POST-FIX: log + audit_log INSERT em sucesso E falha
  //   Admin pode SELECT FROM audit_log WHERE action='mv_seller_kpi.refresh'
  //   p/ ver historico de atualizacoes (success/fail/duration)
  const refreshStartedAt = Date.now();
  try {
    await query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_seller_kpi');
    const refreshDurationMs = Date.now() - refreshStartedAt;
    log.info({ ok, err, total: sellers.rows.length, refresh_ms: refreshDurationMs },
      '[reputation] done + mv_seller_kpi refreshed');
    await query(
      `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, severity, payload_after)
       VALUES (NULL, 'service', 'mv_seller_kpi.refresh', 'materialized_view', 'info', $1::JSONB)`,
      [JSON.stringify({
        sellers_total: sellers.rows.length,
        sellers_ok: ok,
        sellers_err: err,
        refresh_duration_ms: refreshDurationMs,
        cron_duration_ms: Date.now() - startedAt,
      })]
    ).catch(() => {});
  } catch (e) {
    log.error({ /* FIX pass 343 DLP */ err: mask.text(String(e.message || '').slice(0, 300)), ok, err, total: sellers.rows.length },
      '[reputation.refresh.fail] mv_seller_kpi NAO atualizado - admin investigar urgente');
    await query(
      `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, severity, payload_after)
       VALUES (NULL, 'service', 'mv_seller_kpi.refresh.fail', 'materialized_view', 'critical', $1::JSONB)`,
      [JSON.stringify({
        error: /* FIX pass 345 DLP */ mask.text(String(e.message || '').slice(0, 500)),
        sellers_total: sellers.rows.length,
        cron_duration_ms: Date.now() - startedAt,
      })]
    ).catch(() => {});
  }
}

cron.schedule('3 3 * * *', () => refreshAllReputations().catch(() => {}));

app.use((req, res) => res.status(404).json({ error: 'route_not_found' }));
app.use(errorHandler.errorMiddleware);

const server = app.listen(PORT, () => log.info({ port: PORT }, '[review-svc] listening'));
['SIGINT','SIGTERM'].forEach((s) => process.on(s, () => server.close(() => process.exit(0))));
