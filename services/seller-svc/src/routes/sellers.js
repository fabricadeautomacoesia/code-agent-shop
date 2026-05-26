'use strict';

const express = require('express');
const { z } = require('zod');
const { query } = require('@cas/db-client');
const { jwt, asyncHandler, validate, errorHandler } = require('@cas/shared');

const router = express.Router();

// GET /sellers - listagem publica (storefront)
router.get('/', asyncHandler(async (req, res) => {
  const { page = 1, limit = 24, sort = 'rep_desc', tier, search } = req.query;
  const lim = Math.min(parseInt(limit, 10) || 24, 100);
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
router.get('/:slug', asyncHandler(async (req, res, next) => {
  const r = await query(
    `SELECT s.id, s.store_slug, s.store_name, s.store_description,
            s.store_banner_url, s.store_logo_url,
            s.reputation_tier, s.reputation_score, s.total_sales, s.avg_rating,
            s.total_products_active, s.created_at,
            u.display_name AS owner_name
       FROM sellers s
       JOIN users u ON u.id = s.user_id
      WHERE s.store_slug = $1 AND s.status = 'active' AND s.deleted_at IS NULL`,
    [req.params.slug]
  );
  if (!r.rows.length) return next(errorHandler.notFound('seller_not_found'));
  res.json({ seller: r.rows[0] });
}));

// GET /sellers/:slug/products - produtos publicos do seller
router.get('/:slug/products', asyncHandler(async (req, res) => {
  const lim = Math.min(parseInt(req.query.limit, 10) || 24, 100);
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
