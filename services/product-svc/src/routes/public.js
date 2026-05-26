'use strict';

const express = require('express');
const { z } = require('zod');
const { query } = require('@cas/db-client');
const { asyncHandler, validate, errorHandler } = require('@cas/shared');

const router = express.Router();

// GET /products - listagem + filtros facetados
router.get('/', asyncHandler(async (req, res) => {
  const lim = Math.min(parseInt(req.query.limit, 10) || 24, 60);
  const off = (Math.max(parseInt(req.query.page, 10) || 1, 1) - 1) * lim;

  const where = [`status = 'approved'`];
  const params = [];
  let i = 1;

  if (req.query.category) {
    where.push(`category_id = (SELECT id FROM categories WHERE slug = $${i++})`);
    params.push(req.query.category);
  }
  if (req.query.kind) {
    where.push(`kind = $${i++}`); params.push(req.query.kind);
  }
  if (req.query.min_price) {
    where.push(`price_cents >= $${i++}`); params.push(parseInt(req.query.min_price, 10));
  }
  if (req.query.max_price) {
    where.push(`price_cents <= $${i++}`); params.push(parseInt(req.query.max_price, 10));
  }
  if (req.query.free === 'true') where.push(`is_free = TRUE`);
  if (req.query.platform_owned === 'true') where.push(`is_platform_owned = TRUE`);

  const order = ({
    relevance:    'sales_count DESC, avg_rating DESC NULLS LAST',
    newest:       'published_at DESC NULLS LAST',
    price_asc:    'price_cents ASC',
    price_desc:   'price_cents DESC',
    rating:       'avg_rating DESC NULLS LAST, review_count DESC',
    sales:        'sales_count DESC',
  })[req.query.sort] || 'sales_count DESC, avg_rating DESC NULLS LAST';

  params.push(lim, off);
  const r = await query(
    `SELECT id, slug, title, subtitle, short_description, kind, cover_image_url,
            price_cents, currency, license_kind, is_free, tech_stack,
            avg_rating, review_count, sales_count, is_platform_owned, published_at,
            (SELECT store_slug FROM sellers WHERE id = products.seller_id) AS seller_slug,
            (SELECT store_name FROM sellers WHERE id = products.seller_id) AS seller_name,
            (SELECT slug FROM categories WHERE id = products.category_id) AS category_slug
       FROM products
      WHERE ${where.join(' AND ')} AND deleted_at IS NULL
      ORDER BY ${order}
      LIMIT $${i++} OFFSET $${i++}`,
    params
  );
  res.json({ products: r.rows });
}));

// GET /products/:slug - detalhe publico
router.get('/:slug', asyncHandler(async (req, res, next) => {
  const r = await query(
    `SELECT p.*,
            s.id AS seller_id, s.store_slug, s.store_name, s.store_logo_url,
            s.reputation_tier, s.reputation_score, s.avg_rating AS seller_rating,
            c.slug AS category_slug, c.name AS category_name,
            (SELECT json_agg(t.*) FROM tags t JOIN product_tags pt ON pt.tag_id = t.id WHERE pt.product_id = p.id) AS tags,
            (SELECT json_agg(pv.* ORDER BY pv.created_at DESC) FROM product_versions pv WHERE pv.product_id = p.id) AS versions,
            (SELECT json_agg(pm.* ORDER BY pm.sort_order) FROM product_media pm WHERE pm.product_id = p.id) AS media
       FROM products p
       LEFT JOIN sellers s ON s.id = p.seller_id
       LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.slug = $1 AND p.status = 'approved' AND p.deleted_at IS NULL`,
    [req.params.slug]
  );
  if (!r.rows.length) return next(errorHandler.notFound('product_not_found'));
  delete r.rows[0].search_tsv;
  // log de visualizacao assincrono
  query(
    `INSERT INTO product_views (product_id, ip_address, referrer, user_agent)
     VALUES ($1, $2, $3, $4)`,
    [r.rows[0].id, req.ip, req.headers.referer || null, req.headers['user-agent'] || null]
  ).catch(() => {});
  query('UPDATE products SET view_count = view_count + 1 WHERE id = $1', [r.rows[0].id]).catch(() => {});
  res.json({ product: r.rows[0] });
}));

// GET /products/:slug/reviews
router.get('/:slug/reviews', asyncHandler(async (req, res) => {
  const lim = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const off = (Math.max(parseInt(req.query.page, 10) || 1, 1) - 1) * lim;
  const r = await query(
    `SELECT r.id, r.rating, r.title, r.body, r.is_verified_purchase, r.helpful_count, r.unhelpful_count,
            r.reply_from_seller, r.reply_at, r.created_at,
            u.display_name AS buyer_name, u.avatar_url AS buyer_avatar
       FROM product_reviews r
       JOIN products p ON p.id = r.product_id
       LEFT JOIN users u ON u.id = r.buyer_user_id
      WHERE p.slug = $1 AND r.is_hidden = FALSE
      ORDER BY r.helpful_count DESC, r.created_at DESC LIMIT $2 OFFSET $3`,
    [req.params.slug, lim, off]
  );
  res.json({ reviews: r.rows });
}));

// GET /products/:slug/qna
router.get('/:slug/qna', asyncHandler(async (req, res) => {
  const r = await query(
    `SELECT q.id, q.question, q.answer, q.is_pinned, q.upvote_count,
            q.asked_at, q.answered_at,
            ua.display_name AS asker_name,
            us.display_name AS answerer_name
       FROM product_qna q
       JOIN products p ON p.id = q.product_id
       LEFT JOIN users ua ON ua.id = q.asked_by_user_id
       LEFT JOIN users us ON us.id = q.answered_by_user_id
      WHERE p.slug = $1 AND q.is_hidden = FALSE AND q.is_public = TRUE
      ORDER BY q.is_pinned DESC, q.asked_at DESC LIMIT 50`,
    [req.params.slug]
  );
  res.json({ qna: r.rows });
}));

module.exports = router;
