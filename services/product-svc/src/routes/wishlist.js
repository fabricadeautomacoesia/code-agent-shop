'use strict';

const express = require('express');
const { z } = require('zod');
const { query } = require('@cas/db-client');
const { jwt, asyncHandler, validate, errorHandler } = require('@cas/shared');

const router = express.Router();
router.use(jwt.requireAuth());

// GET /products/wishlist - lista favoritos do user logado
router.get('/', asyncHandler(async (req, res) => {
  const r = await query(
    `SELECT p.id, p.slug, p.title, p.subtitle, p.short_description, p.kind,
            p.cover_image_url, p.price_cents, p.currency, p.is_free,
            p.avg_rating, p.review_count, p.sales_count, p.is_platform_owned,
            (SELECT store_slug FROM sellers WHERE id = p.seller_id) AS store_slug,
            (SELECT store_name FROM sellers WHERE id = p.seller_id) AS store_name,
            (SELECT slug FROM categories WHERE id = p.category_id) AS category_slug,
            (SELECT reputation_tier FROM sellers WHERE id = p.seller_id) AS reputation_tier,
            w.created_at AS favorited_at
       FROM product_wishlist w
       JOIN products p ON p.id = w.product_id
      WHERE w.user_id = $1 AND p.status = 'approved' AND p.deleted_at IS NULL
      ORDER BY w.created_at DESC LIMIT 200`, [req.user.sub]
  );
  res.json({ products: r.rows, count: r.rows.length });
}));

// POST /products/wishlist - adiciona aos favoritos
// FIX-WORKER-7: antes vazava FK violation 500 com nome de constraint Postgres ao cliente.
// Agora pre-valida existencia do produto -> 404 product_not_found (sem leak).
router.post('/',
  validate({ body: z.object({ product_id: z.string().uuid() }) }),
  asyncHandler(async (req, res, next) => {
    const exists = await query(
      `SELECT 1 FROM products WHERE id = $1 AND deleted_at IS NULL AND status = 'approved'`,
      [req.body.product_id]
    );
    if (!exists.rows.length) return next(errorHandler.notFound('product_not_found'));
    try {
      await query(
        `INSERT INTO product_wishlist (user_id, product_id) VALUES ($1, $2)
         ON CONFLICT (user_id, product_id) DO NOTHING`,
        [req.user.sub, req.body.product_id]
      );
    } catch (e) {
      // defesa em profundidade caso outra constraint dispare (e.g. user deletado)
      if (e.code === '23503') return next(errorHandler.notFound('product_not_found'));
      throw e;
    }
    res.json({ ok: true });
  })
);

// DELETE /products/wishlist/:product_id
router.delete('/:product_id', asyncHandler(async (req, res) => {
  await query(
    `DELETE FROM product_wishlist WHERE user_id = $1 AND product_id = $2`,
    [req.user.sub, req.params.product_id]
  );
  res.json({ ok: true });
}));

// GET /products/wishlist/:product_id/check - retorna se esta favoritado
router.get('/:product_id/check', asyncHandler(async (req, res) => {
  const r = await query(
    `SELECT 1 FROM product_wishlist WHERE user_id = $1 AND product_id = $2`,
    [req.user.sub, req.params.product_id]
  );
  res.json({ favorited: r.rows.length > 0 });
}));

module.exports = router;
