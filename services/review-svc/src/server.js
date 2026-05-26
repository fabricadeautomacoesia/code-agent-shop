'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const express = require('express');
const cron = require('node-cron');
const { z } = require('zod');
const { query, tx } = require('@cas/db-client');
const { logger, sanitize, errorHandler, asyncHandler, validate, jwt } = require('@cas/shared');

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
app.post('/', jwt.requireAuth(), validate({ body: reviewSchema }), asyncHandler(async (req, res, next) => {
  const b = req.body;
  // valida compra
  const oi = await query(
    `SELECT oi.product_id, oi.seller_id FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE o.id = $1 AND o.buyer_user_id = $2 AND oi.product_id = $3
        AND o.status IN ('paid','fulfilled')`,
    [b.order_id, req.user.sub, b.product_id]
  );
  if (!oi.rows.length) return next(errorHandler.forbidden('not_a_verified_purchase'));

  try {
    const r = await query(
      `INSERT INTO product_reviews
        (product_id, order_id, buyer_user_id, seller_id, rating, title, body, is_verified_purchase)
       VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE)
       RETURNING *`,
      [b.product_id, b.order_id, req.user.sub, oi.rows[0].seller_id || null,
       b.rating, b.title || null, b.body || null]
    );
    // recalcular avg_rating do produto
    await query(
      `UPDATE products SET
         avg_rating = (SELECT AVG(rating) FROM product_reviews WHERE product_id = $1 AND is_hidden = FALSE),
         review_count = (SELECT COUNT(*) FROM product_reviews WHERE product_id = $1 AND is_hidden = FALSE)
       WHERE id = $1`, [b.product_id]
    );
    // notification ao seller
    if (oi.rows[0].seller_id) {
      await query(
        `INSERT INTO notifications (user_id, channel, template_code, title, body)
         SELECT user_id, 'in_app', 'review_received', $1, $2 FROM sellers WHERE id = $3`,
        [`Nova avaliacao: ${b.rating} estrelas`, b.body || `Voce recebeu ${b.rating} estrelas`, oi.rows[0].seller_id]
      );
    }
    res.status(201).json({ review: r.rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'already_reviewed' });
    throw e;
  }
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
    // notification ao seller
    if (p.rows[0].seller_id) {
      await query(
        `INSERT INTO notifications (user_id, channel, template_code, title, body)
         SELECT user_id, 'in_app', 'qna_question', 'Nova pergunta', $1 FROM sellers WHERE id = $2`,
        [`Nova pergunta sobre produto`, p.rows[0].seller_id]
      );
    }
    res.status(201).json({ qna: r.rows[0] });
  })
);

// ============================================================
// REPORTS
// ============================================================
app.post('/reports', jwt.requireAuth(),
  validate({ body: z.object({
    target_type: z.enum(['product','seller','review','user','qna']),
    target_id: z.string().uuid(),
    reason_code: z.enum(['plagiarism','spam','scam','offensive','copyright','other']),
    description: z.string().max(2000).optional(),
    evidence_urls: z.array(z.string().url()).optional(),
  })}),
  asyncHandler(async (req, res) => {
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
