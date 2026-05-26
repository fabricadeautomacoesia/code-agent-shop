'use strict';

const express = require('express');
const { query } = require('@cas/db-client');
const { jwt, asyncHandler, errorHandler } = require('@cas/shared');

const router = express.Router();
router.use(jwt.requireAuth());

// GET /orders/download/:token - gera URL assinada do pacote do produto comprado
router.get('/:token', asyncHandler(async (req, res, next) => {
  const r = await query(
    `SELECT oi.id, oi.product_id, oi.license_key, oi.download_count, oi.download_expires_at,
            o.status AS order_status, p.package_url, p.title
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN products p ON p.id = oi.product_id
      WHERE oi.download_token = $1 AND o.buyer_user_id = $2`,
    [req.params.token, req.user.sub]
  );
  if (!r.rows.length) return next(errorHandler.notFound('download_not_found'));
  const item = r.rows[0];
  if (!['paid','fulfilled'].includes(item.order_status)) return next(errorHandler.forbidden('order_not_paid'));
  if (new Date(item.download_expires_at) < new Date()) return next(errorHandler.forbidden('download_expired'));
  if (!item.package_url) return next(errorHandler.notFound('package_not_set'));

  await query('UPDATE order_items SET download_count = download_count + 1 WHERE id = $1', [item.id]);
  await query(`UPDATE orders SET fulfilled_at = COALESCE(fulfilled_at, NOW()), status = 'fulfilled'
               WHERE id = (SELECT order_id FROM order_items WHERE id = $1)`, [item.id]);

  res.json({
    download_url: item.package_url,
    license_key: item.license_key,
    title: item.title,
    expires_at: item.download_expires_at,
    download_count: item.download_count + 1,
  });
}));

module.exports = router;
