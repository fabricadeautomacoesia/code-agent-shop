'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const express = require('express');
const cron = require('node-cron');
const { z } = require('zod');
const { query, tx } = require('@cas/db-client');
const { logger, sanitize, errorHandler, asyncHandler, validate, jwt, cache, rateLimiter } = require('@cas/shared');

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
app.post('/:id/vote', jwt.requireAuth(),
  validate({ body: z.object({ vote: z.literal(1).or(z.literal(-1)) }) }),
  asyncHandler(async (req, res) => {
    await query(
      `INSERT INTO review_votes (review_id, user_id, vote) VALUES ($1,$2,$3)
       ON CONFLICT (review_id, user_id) DO UPDATE SET vote = EXCLUDED.vote`,
      [req.params.id, req.user.sub, req.body.vote]
    );
    const counts = await query(
      `SELECT
         SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END) AS helpful,
         SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END) AS unhelpful
       FROM review_votes WHERE review_id = $1`, [req.params.id]
    );
    await query(
      `UPDATE product_reviews SET helpful_count = $1, unhelpful_count = $2 WHERE id = $3`,
      [parseInt(counts.rows[0].helpful, 10), parseInt(counts.rows[0].unhelpful, 10), req.params.id]
    );
    res.json({ ok: true, helpful_count: counts.rows[0].helpful });
  })
);

// POST /api/reviews/:id/reply (seller)
app.post('/:id/reply', jwt.requireAuth({ roles: ['seller','admin'] }),
  validate({ body: z.object({ reply: z.string().min(1).max(2000) }) }),
  asyncHandler(async (req, res) => {
    await query(
      `UPDATE product_reviews r
          SET reply_from_seller = $1, reply_at = NOW(), updated_at = NOW()
         FROM sellers s
        WHERE r.id = $2 AND r.seller_id = s.id AND s.user_id = $3`,
      [req.body.reply, req.params.id, req.user.sub]
    );
    res.json({ ok: true });
  })
);

// ============================================================
// QnA (routes /api/qna proxied)
// ============================================================
app.post('/qna',  // GW reroteia para /api/qna -> /qna
  jwt.requireAuth(),
  validate({ body: z.object({ product_id: z.string().uuid(), question: z.string().min(5).max(2000) }) }),
  asyncHandler(async (req, res) => {
    const p = await query('SELECT seller_id FROM products WHERE id = $1', [req.body.product_id]);
    if (!p.rows.length) return res.status(404).json({ error: 'product_not_found' });
    const r = await query(
      `INSERT INTO product_qna (product_id, seller_id, asked_by_user_id, question)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.body.product_id, p.rows[0].seller_id || null, req.user.sub, req.body.question]
    );
    if (p.rows[0].seller_id) {
      await query(
        `INSERT INTO notifications (user_id, channel, template_code, title, body)
         SELECT user_id, 'in_app', 'qna_question', 'Nova pergunta', $1 FROM sellers WHERE id = $2`,
        [`Nova pergunta sobre produto`, p.rows[0].seller_id]
      );
    }
    // FIX-WORKER-3 pass 2: invalida cache do PDP qna (60s TTL antes ocultava o post recem-criado)
    const slugR = await query('SELECT slug FROM products WHERE id = $1', [req.body.product_id]);
    if (slugR.rows.length) {
      await cache.del(`products:qna:${slugR.rows[0].slug}`).catch(() => {});
    }
    res.status(201).json({ qna: r.rows[0] });
  })
);

// POST /qna/:id/upvote - votar em uma pergunta (MLB-2)
app.post('/qna/:id/upvote', jwt.requireAuth(),
  asyncHandler(async (req, res) => {
    // tenta inserir voto; se ja existe, remove (toggle)
    const exists = await query(
      `SELECT 1 FROM product_qna_votes WHERE qna_id = $1 AND user_id = $2`,
      [req.params.id, req.user.sub]
    );
    if (exists.rows.length) {
      await query(`DELETE FROM product_qna_votes WHERE qna_id = $1 AND user_id = $2`,
        [req.params.id, req.user.sub]);
    } else {
      await query(`INSERT INTO product_qna_votes (qna_id, user_id) VALUES ($1, $2)
                   ON CONFLICT DO NOTHING`, [req.params.id, req.user.sub]);
    }
    // recalcula contador
    const c = await query(`SELECT COUNT(*)::INT AS n FROM product_qna_votes WHERE qna_id = $1`, [req.params.id]);
    await query(`UPDATE product_qna SET upvote_count = $1 WHERE id = $2`, [c.rows[0].n, req.params.id]);
    res.json({ ok: true, upvote_count: c.rows[0].n, voted: !exists.rows.length });
  })
);

// GET /qna/:id/voted - checa se user votou
app.get('/qna/:id/voted', jwt.requireAuth(),
  asyncHandler(async (req, res) => {
    const r = await query(
      `SELECT 1 FROM product_qna_votes WHERE qna_id = $1 AND user_id = $2`,
      [req.params.id, req.user.sub]
    );
    res.json({ voted: r.rows.length > 0 });
  })
);

// GET /qna/seller/pending - perguntas pendentes do seller logado
app.get('/qna/seller/pending', jwt.requireAuth({ roles: ['seller','admin'] }),
  asyncHandler(async (req, res) => {
    const r = await query(
      `SELECT q.id, q.question, q.asked_at, q.upvote_count,
              p.id AS product_id, p.slug AS product_slug, p.title AS product_title, p.cover_image_url,
              u.display_name AS asker_name, u.email AS asker_email
         FROM product_qna q
         JOIN products p ON p.id = q.product_id
         JOIN sellers s ON s.id = q.seller_id
         LEFT JOIN users u ON u.id = q.asked_by_user_id
        WHERE s.user_id = $1 AND q.answer IS NULL AND q.is_hidden = FALSE
        ORDER BY q.asked_at ASC LIMIT 100`, [req.user.sub]
    );
    res.json({ qna: r.rows });
  })
);

// POST /qna/:id/answer (seller responde)
app.post('/qna/:id/answer', jwt.requireAuth({ roles: ['seller','admin'] }),
  validate({ body: z.object({ answer: z.string().min(1).max(5000) }) }),
  asyncHandler(async (req, res) => {
    const r = await query(
      `UPDATE product_qna q
          SET answer = $1, answered_at = NOW(), answered_by_user_id = $2, updated_at = NOW()
         FROM sellers s
        WHERE q.id = $3 AND q.seller_id = s.id AND s.user_id = $2
        RETURNING q.id, q.product_id, q.asked_by_user_id`,
      [req.body.answer, req.user.sub, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'not_found_or_not_owner' });
    // notifica quem perguntou
    if (r.rows[0].asked_by_user_id) {
      await query(
        `INSERT INTO notifications (user_id, channel, template_code, title, body)
         VALUES ($1, 'in_app', 'qna_answered', 'Sua pergunta foi respondida', 'Acesse o produto para ver a resposta')`,
        [r.rows[0].asked_by_user_id]
      );
    }
    // FIX-WORKER-3 pass 2: invalida cache qna do PDP (answer agora aparece)
    const slugR = await query('SELECT slug FROM products WHERE id = $1', [r.rows[0].product_id]);
    if (slugR.rows.length) {
      await cache.del(`products:qna:${slugR.rows[0].slug}`).catch(() => {});
    }
    res.json({ ok: true });
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
app.post('/reports', jwt.requireAuth(),
  validate({ body: z.object({
    target_type: z.enum(['product','seller','review','user','qna']),
    target_id: z.string().uuid(),
    reason_code: z.enum(['plagiarism','spam','scam','offensive','copyright','other']),
    description: z.string().max(2000).optional(),
    evidence_urls: z.array(z.string().url()).optional(),
  })}),
  asyncHandler(async (req, res, next) => {
    const tbl = TARGET_TABLE_MAP[req.body.target_type];
    // 1. Valida existencia do target (anti-spam UUID fake)
    const exists = await query(
      `SELECT 1 FROM ${tbl} WHERE id = $1 LIMIT 1`,
      [req.body.target_id]
    );
    if (!exists.rows.length) {
      return next(errorHandler.notFound('target_not_found'));
    }
    // 2. Dedup: mesmo user nao pode reportar o mesmo target+reason 2x em 7 dias
    const dup = await query(
      `SELECT 1 FROM reports
        WHERE reporter_user_id = $1 AND target_type = $2 AND target_id = $3
          AND reason_code = $4 AND created_at > NOW() - INTERVAL '7 days'
        LIMIT 1`,
      [req.user.sub, req.body.target_type, req.body.target_id, req.body.reason_code]
    );
    if (dup.rows.length) {
      return next(errorHandler.conflict('duplicate_report', 'Voce ja reportou este item nos ultimos 7 dias'));
    }
    const r = await query(
      `INSERT INTO reports (reporter_user_id, target_type, target_id, reason_code, description, evidence_urls)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.sub, req.body.target_type, req.body.target_id, req.body.reason_code,
       req.body.description || null, req.body.evidence_urls || null]
    );
    // alerta para admin
    await query(
      `INSERT INTO alerts (severity, source, code, title, message, target_type, target_id)
       VALUES ('warn','reports','new_report',$1,$2,$3,$4)`,
      [`Nova denuncia: ${req.body.reason_code}`,
       `Reporter: ${req.user.sub}. Motivo: ${req.body.reason_code}. ${req.body.description || ''}`.slice(0, 500),
       req.body.target_type, req.body.target_id]
    );
    res.status(201).json({ report: r.rows[0] });
  })
);

// Gateway proxia /api/reviews/* sem prefix - rotas chegam direto na raiz
// GET /seller/received - reviews recebidas pelo seller logado
app.get('/seller/received', jwt.requireAuth({ roles: ['seller','admin'] }),
  asyncHandler(async (req, res) => {
    const r = await query(
      `SELECT r.id, r.rating, r.title, r.body, r.is_verified_purchase,
              r.helpful_count, r.unhelpful_count, r.reply_from_seller, r.reply_at,
              r.created_at,
              p.id AS product_id, p.slug AS product_slug, p.title AS product_title, p.cover_image_url,
              u.display_name AS buyer_name, u.email AS buyer_email
         FROM product_reviews r
         JOIN products p ON p.id = r.product_id
         JOIN sellers s ON s.id = r.seller_id
         LEFT JOIN users u ON u.id = r.buyer_user_id
        WHERE s.user_id = $1 AND r.is_hidden = FALSE
        ORDER BY r.created_at DESC LIMIT 100`, [req.user.sub]
    );
    res.json({ reviews: r.rows });
  })
);

// GET /admin/reports?status=open (acessada via /api/reviews/admin/reports)
app.get('/admin/reports', jwt.requireAuth({ roles: ['admin','staff'] }),
  asyncHandler(async (req, res) => {
    const status = req.query.status || 'open';
    const r = await query(
      `SELECT r.*, u.email AS reporter_email, u.full_name AS reporter_name
         FROM reports r
         LEFT JOIN users u ON u.id = r.reporter_user_id
        WHERE r.status = $1
        ORDER BY r.created_at DESC LIMIT 200`, [status]
    );
    res.json({ reports: r.rows });
  })
);

// POST /reports/:id/resolve (via /api/reviews/reports/:id/resolve)
app.post('/reports/:id/resolve', jwt.requireAuth({ roles: ['admin','staff'] }),
  validate({ body: z.object({ status: z.enum(['resolved','dismissed','under_review']), notes: z.string().max(2000) }) }),
  asyncHandler(async (req, res) => {
    await query(
      `UPDATE reports SET status = $1, resolution_notes = $2, resolved_by = $3, resolved_at = NOW()
        WHERE id = $4`,
      [req.body.status, req.body.notes, req.user.sub, req.params.id]
    );
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
