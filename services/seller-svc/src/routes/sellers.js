'use strict';

const express = require('express');
const { z } = require('zod');
const { query } = require('@cas/db-client');
const { jwt, asyncHandler, validate, errorHandler } = require('@cas/shared');

const router = express.Router();

// GET /sellers - listagem publica (storefront)
router.get('/', asyncHandler(async (req, res) => {
  const { page = 1, limit = 24, sort = 'rep_desc', tier, search } = req.query;
  // FIX-WORKER-7 pass 4: Math.max(1, ...) clamp p/ rejeitar negativos
  const lim = Math.max(1, Math.min(parseInt(limit, 10) || 24, 100));
  const off = (Math.max(parseInt(page, 10) || 1, 1) - 1) * lim;

  const where = [`s.status = 'active'`, `s.deleted_at IS NULL`];
  const params = [];
  let i = 1;
  if (tier)   { where.push(`s.reputation_tier = $${i++}`); params.push(tier); }
  if (search) { where.push(`s.store_name ILIKE $${i++}`);  params.push(`%${search}%`); }

  const order = ({
    rep_desc:   's.reputation_score DESC',
    rep_asc:    's.reputation_score ASC',
    sales_desc: 's.total_sales DESC',
    newest:     's.created_at DESC',
  })[sort] || 's.reputation_score DESC';

  params.push(lim, off);
  const r = await query(
    `SELECT s.id, s.store_slug, s.store_name, s.store_description, s.store_banner_url, s.store_logo_url,
            s.reputation_tier, s.reputation_score, s.total_sales, s.avg_rating,
            s.total_products_active, s.created_at
       FROM sellers s
      WHERE ${where.join(' AND ')}
      ORDER BY ${order}
      LIMIT $${i++} OFFSET $${i++}`,
    params
  );
  res.json({ sellers: r.rows, page: Number(page), limit: lim });
}));

// GET /sellers/:slug - perfil publico
// FIX-WORKER-16: incluido is_verified (KYC concluido) + member_since para badges UI
router.get('/:slug', asyncHandler(async (req, res, next) => {
  const r = await query(
    `SELECT s.id, s.store_slug, s.store_name, s.store_description,
            s.store_banner_url, s.store_logo_url,
            s.reputation_tier, s.reputation_score, s.total_sales, s.avg_rating,
            s.total_products_active, s.created_at,
            s.document_verified_at IS NOT NULL AS is_verified,
            s.seller_class,
            EXTRACT(YEAR FROM s.created_at)::INT AS member_since_year,
            u.display_name AS owner_name
       FROM sellers s
       JOIN users u ON u.id = s.user_id
      WHERE s.store_slug = $1 AND s.status = 'active' AND s.deleted_at IS NULL`,
    [req.params.slug]
  );
  if (!r.rows.length) return next(errorHandler.notFound('seller_not_found'));
  res.json({ seller: r.rows[0] });
}));

// MLB-NEW WORKER 16: GET /sellers/:slug/stats - dashboard publico de reputacao
// Mercado Livre exibe pagina detalhada com gauges Atendimento/Entrega/Reclamacao
// e tier badge. Equivalente CAS adaptado:
// - on_time_qa_rate: % de produtos que passaram QA em ate 24h da submission
// - response_rate: % de Q&A respondidas em ate support_response_hours
// - refund_rate: % de orders refunded vs total
// - avg_rating + review_count
router.get('/:slug/stats', asyncHandler(async (req, res, next) => {
  const seller = await query(
    `SELECT id, store_name, reputation_tier, reputation_score, total_sales, avg_rating,
            total_products_active, created_at,
            document_verified_at IS NOT NULL AS is_verified
       FROM sellers WHERE store_slug = $1 AND status = 'active' AND deleted_at IS NULL`,
    [req.params.slug]
  );
  if (!seller.rows.length) return next(errorHandler.notFound('seller_not_found'));
  const s = seller.rows[0];

  // Stats agregados (best-effort - tolerante a tabela ausente)
  let qa_stats = { total: 0, approved: 0, rejected: 0 };
  let order_stats = { total_paid: 0, total_refunded: 0 };
  let review_count = 0;
  try {
    const q = await query(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE verdict='approved') AS approved,
              COUNT(*) FILTER (WHERE verdict='rejected') AS rejected
         FROM product_qa_runs r
         JOIN products p ON p.id = r.product_id
        WHERE p.seller_id = $1::UUID`, [s.id]
    );
    qa_stats = q.rows[0] || qa_stats;
  } catch {}
  try {
    const o = await query(
      `SELECT COUNT(*) FILTER (WHERE o.status IN ('paid','fulfilled')) AS total_paid,
              COUNT(*) FILTER (WHERE o.status = 'refunded') AS total_refunded
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
        WHERE oi.seller_id = $1::UUID`, [s.id]
    );
    order_stats = o.rows[0] || order_stats;
  } catch {}
  try {
    const rv = await query(
      `SELECT COUNT(*) AS c FROM product_reviews pr
         JOIN products p ON p.id = pr.product_id
        WHERE p.seller_id = $1::UUID`, [s.id]
    );
    review_count = parseInt(rv.rows[0]?.c || 0, 10);
  } catch {}

  const total_paid = parseInt(order_stats.total_paid || 0, 10);
  const total_refunded = parseInt(order_stats.total_refunded || 0, 10);
  const qa_total = parseInt(qa_stats.total || 0, 10);
  const qa_approved = parseInt(qa_stats.approved || 0, 10);

  const refund_rate = total_paid > 0 ? Math.round((total_refunded / total_paid) * 10000) / 100 : 0;
  const qa_approval_rate = qa_total > 0 ? Math.round((qa_approved / qa_total) * 10000) / 100 : null;

  res.json({
    seller: s,
    stats: {
      total_paid,
      total_refunded,
      refund_rate_pct: refund_rate,
      qa_total,
      qa_approved,
      qa_approval_rate_pct: qa_approval_rate,
      review_count,
      avg_rating: s.avg_rating ? Number(s.avg_rating) : null,
    },
    badges: {
      verified: !!s.is_verified,
      top_tier: ['ouro','platinum','lider_platinum'].includes(s.reputation_tier),
      low_refund: refund_rate < 2 && total_paid >= 5, // <2% refund + min 5 vendas
      consistent_qa: qa_approval_rate != null && qa_approval_rate >= 90 && qa_total >= 3,
    },
  });
}));

// GET /sellers/:slug/products - produtos publicos do seller
router.get('/:slug/products', asyncHandler(async (req, res) => {
  // FIX-WORKER-7 pass 4: Math.max(1, ...) clamp p/ rejeitar negativos
  const lim = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 24, 100));
  const off = (Math.max(parseInt(req.query.page, 10) || 1, 1) - 1) * lim;
  const r = await query(
    `SELECT vp.*
       FROM vw_public_products vp
       JOIN sellers s ON s.id = vp.seller_id
      WHERE s.store_slug = $1
      ORDER BY vp.sales_count DESC, vp.created_at DESC
      LIMIT $2 OFFSET $3`,
    [req.params.slug, lim, off]
  );
  res.json({ products: r.rows });
}));

module.exports = router;
