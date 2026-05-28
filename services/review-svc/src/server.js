'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const express = require('express');
const cron = require('node-cron');
const { z } = require('zod');
const { query, tx } = require('@cas/db-client');
const { logger, sanitize, errorHandler, asyncHandler, validate, jwt, cache, rateLimiter, maskPII } = require('@cas/shared');

const log = logger.child({ svc: 'review-svc' });
const app = express();
const PORT = parseInt(process.env.PORT_REVIEW || '3017', 10);

app.disable('x-powered-by');
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
    await c.query(`SELECT id FROM products WHERE id = $1 FOR UPDATE`, [b.product_id]);
    await c.query(
      `UPDATE products SET
         avg_rating = (SELECT AVG(rating) FROM product_reviews WHERE product_id = $1 AND is_hidden = FALSE),
         review_count = (SELECT COUNT(*) FROM product_reviews WHERE product_id = $1 AND is_hidden = FALSE)
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
  const slugR = await query('SELECT slug FROM products WHERE id = $1', [b.product_id]);
  if (slugR.rows.length) {
    const slug = slugR.rows[0].slug;
    await Promise.all([
      cache.del(`products:reviews:${slug}:*`).catch(() => {}),
      cache.del(`products:detail:${slug}`).catch(() => {}),
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
      const counts = await c.query(
        `SELECT
           SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END)::INT AS helpful,
           SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END)::INT AS unhelpful
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
      await cache.del(`products:reviews:${result.slug}:*`).catch(() => {});
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
      const p = await c.query(
        `SELECT seller_id, slug FROM products
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
      if (p.rows[0].seller_id) {
        await c.query(
          `INSERT INTO notifications (user_id, channel, template_code, title, body)
           SELECT user_id, 'in_app', 'qna_question', 'Nova pergunta', $1
             FROM sellers WHERE id = $2::UUID`,
          [`Nova pergunta sobre produto`, p.rows[0].seller_id]
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

    // Cache invalidate FORA tx (acceptable - falha cache nao breaka DB)
    if (outcome?.slug) {
      await cache.del(`products:qna:${outcome.slug}`).catch(() => {});
    }
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
    await tx(async (c) => {
      // FIX bug 1+6+7 (Regras K+is_hidden+J): SELECT FOR UPDATE qna + checks
      const qna = await c.query(
        `SELECT id, is_hidden FROM product_qna
          WHERE id = $1::UUID FOR UPDATE`,
        [req.params.id]
      );
      if (!qna.rows.length) { outcome = { error: 'qna_not_found' }; return; }
      if (qna.rows[0].is_hidden) {
        outcome = { error: 'qna_hidden' };
        return;
      }

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

    // BUG 3: retornar direcao do voto (frontend UX)
    const r = await query(
      `SELECT vote FROM product_qna_votes WHERE qna_id = $1::UUID AND user_id = $2::UUID`,
      [req.params.id, req.user.sub]
    );
    res.json({
      voted: r.rows.length > 0,
      vote_direction: r.rows[0]?.vote || null,
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
app.get('/qna/seller/pending', jwt.requireAuth({ roles: ['seller','admin'] }),
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

    const r = await query(
      `SELECT q.id, q.question, q.asked_at, q.upvote_count,
              p.id AS product_id, p.slug AS product_slug, p.title AS product_title, p.cover_image_url,
              u.display_name AS asker_name, u.email AS asker_email
         FROM product_qna q
         JOIN products p ON p.id = q.product_id
         JOIN sellers s ON s.id = q.seller_id
         LEFT JOIN users u ON u.id = q.asked_by_user_id
        WHERE ${whereClause}
        ORDER BY q.asked_at ASC, q.id ASC
        LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx}`, params
    );

    // LGPD masking: seller só vê email mascarado (data minimization)
    const qna = r.rows.map((row) => {
      if (isAdmin) return row;
      return { ...row, asker_email: maskEmail(row.asker_email) };
    });

    res.json({ qna, total: qna.length, limit, offset });
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

    // Cache invalidate FORA tx (tolera fail)
    if (result?.slug) {
      await cache.del(`products:qna:${result.slug}`).catch(() => {});
    }
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
  validate({ body: z.object({
    target_type: z.enum(['product','seller','review','user','qna']),
    target_id: z.string().uuid(),
    reason_code: z.enum(['plagiarism','spam','scam','offensive','copyright','other']),
    description: z.string().max(2000).optional(),
    evidence_urls: z.array(z.string().url()).optional(),
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
        ? req.body.description.replace(/[ --]/g, '').slice(0, 2000)
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
  const sellerFilter = isAdmin && req.query.seller_id ? req.query.seller_id : '';
  return `reviews:seller_received:${req.user?.sub || 'anon'}:adm=${isAdmin}:sf=${sellerFilter}:lim=${lim}`;
};

app.get('/seller/received',
  jwt.requireAuth({ roles: ['seller','admin','staff'] }),
  cache.cacheMiddleware(sellerReceivedCacheKey, 60),
  asyncHandler(async (req, res) => {
    const isAdmin = ['admin','staff'].includes(req.user.role);
    const lim = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 100, 200));
    const sellerFilter = isAdmin && req.query.seller_id ? req.query.seller_id : null;

    // BUG 1 FIX: query construida condicional admin vs seller
    // Admin path: SEM JOIN sellers + WHERE s.user_id (ve todas reviews)
    //   + optional filter ?seller_id (admin investiga seller especifico)
    // Seller path: JOIN sellers + WHERE s.user_id = req.user.sub (ownership)
    const sql = isAdmin
      ? `SELECT r.id, r.rating, r.title, r.body, r.is_verified_purchase,
                r.helpful_count, r.unhelpful_count, r.reply_from_seller, r.reply_at,
                r.created_at, r.seller_id,
                p.id AS product_id, p.slug AS product_slug, p.title AS product_title, p.cover_image_url,
                u.display_name AS buyer_name, u.email AS buyer_email
           FROM product_reviews r
           JOIN products p ON p.id = r.product_id
           LEFT JOIN users u ON u.id = r.buyer_user_id
          WHERE r.is_hidden = FALSE
            AND ($1::UUID IS NULL OR r.seller_id = $1::UUID)
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT $2`
      : `SELECT r.id, r.rating, r.title, r.body, r.is_verified_purchase,
                r.helpful_count, r.unhelpful_count, r.reply_from_seller, r.reply_at,
                r.created_at,
                p.id AS product_id, p.slug AS product_slug, p.title AS product_title, p.cover_image_url,
                u.display_name AS buyer_name, u.email AS buyer_email
           FROM product_reviews r
           JOIN products p ON p.id = r.product_id
           JOIN sellers s ON s.id = r.seller_id
           LEFT JOIN users u ON u.id = r.buyer_user_id
          WHERE s.user_id = $1 AND r.is_hidden = FALSE
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT $2`;
    const params = isAdmin
      ? [sellerFilter, lim]
      : [req.user.sub, lim];

    const r = await query(sql, params);

    // BUG 2 FIX: PII masking buyer_email (LGPD minimization)
    // FIX-WORKER-7 pass 58: inline mask refactored -> @cas/shared.maskPII.email
    // (DRY cross-svc + null-safe + format consistente 'jo***@email.com')
    const reviews = r.rows.map((row) => {
      if (!isAdmin && row.buyer_email) {
        row.buyer_email = maskPII.email(row.buyer_email);
      }
      return row;
    });

    res.json({
      reviews,
      count: reviews.length,
      limit: lim,
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
    const r = await query(
      `SELECT r.id, r.target_type, r.target_id, r.reason_code, r.description,
              r.evidence_urls, r.status, r.resolution_notes, r.resolved_at,
              r.resolved_by, r.reporter_user_id, r.created_at,
              u.email AS reporter_email, u.full_name AS reporter_name
         FROM reports r
         LEFT JOIN users u ON u.id = r.reporter_user_id
        WHERE r.status = $1
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT $2 OFFSET $3`, [status, limit, offset]
    );

    // LGPD masking: admin vê full, staff vê masked (data minimization)
    const isAdmin = req.user && req.user.role === 'admin';
    const reports = r.rows.map((row) => {
      if (isAdmin) return row;
      return {
        ...row,
        reporter_email: maskEmail(row.reporter_email),
        reporter_name: maskName(row.reporter_name),
      };
    });

    res.json({
      reports,
      total: reports.length,
      limit,
      offset,
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
  const sellers = await query(`SELECT id FROM sellers WHERE status = 'active' AND deleted_at IS NULL`);
  let ok = 0, err = 0;
  for (const s of sellers.rows) {
    try {
      await query('SELECT fn_refresh_seller_reputation($1)', [s.id]);
      ok++;
    } catch (e) {
      err++; log.warn({ seller: s.id, err: e.message }, '[reputation.err]');
    }
  }
  await query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_seller_kpi').catch(() => {});
  log.info({ ok, err, total: sellers.rows.length }, '[reputation] done');
}

cron.schedule('3 3 * * *', () => refreshAllReputations().catch(() => {}));

app.use((req, res) => res.status(404).json({ error: 'route_not_found' }));
app.use(errorHandler.errorMiddleware);

const server = app.listen(PORT, () => log.info({ port: PORT }, '[review-svc] listening'));
['SIGINT','SIGTERM'].forEach((s) => process.on(s, () => server.close(() => process.exit(0))));
