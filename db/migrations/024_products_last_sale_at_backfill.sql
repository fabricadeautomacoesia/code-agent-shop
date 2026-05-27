-- Migration 024: Backfill products.last_sale_at + index (WORKER 14 pass 2)
-- =====================================================================
-- PROBLEMA:
-- Coluna products.last_sale_at existia desde a migration inicial mas ZERO
-- code path escrevia nela. Produtos com 500+ sales tinham last_sale_at = NULL.
--
-- Bug detectado via:
--   SELECT slug, last_sale_at, sales_count FROM products WHERE sales_count > 0
-- Resultado: 5/5 produtos com sales_count alto, todos com last_sale_at NULL.
--
-- IMPACTO sem o fix:
-- - "Hot deals" sort by recency impossivel
-- - Trending products MLB-style nao distinguia "538 vendas em 2024" de
--   "538 vendas todas em 2025"
-- - Stale product detection (>= 90 dias sem venda) inviavel
--
-- FIX:
-- 1. payment-svc code patched para UPDATE last_sale_at = NOW() em order paid
-- 2. Migration 024 backfill historico via order_items + orders.paid_at
-- 3. Index parcial idx_products_last_sale para ORDER BY last_sale_at DESC
-- =====================================================================

-- Backfill: max(orders.paid_at) por produto via JOIN order_items
DO $$ BEGIN
  UPDATE products p
     SET last_sale_at = sub.max_paid_at
    FROM (
      SELECT oi.product_id, MAX(o.paid_at) AS max_paid_at
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
       WHERE o.paid_at IS NOT NULL
       GROUP BY oi.product_id
    ) sub
   WHERE p.id = sub.product_id
     AND p.last_sale_at IS NULL;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

-- Index para queries "ORDER BY last_sale_at DESC" e "WHERE last_sale_at > NOW() - INTERVAL 'N days'"
-- Partial: so produtos approved e com venda (significativo p/ trending/hot)
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_products_last_sale
    ON products(last_sale_at DESC NULLS LAST)
    WHERE status = 'approved' AND deleted_at IS NULL AND last_sale_at IS NOT NULL;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;
