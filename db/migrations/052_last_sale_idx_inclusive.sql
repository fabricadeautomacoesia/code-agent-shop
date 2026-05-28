-- Migration 052: idx_products_last_sale INCLUSIVE (W18 pass 130)
--
-- BUG identificado via EXPLAIN ANALYZE em prod:
-- - Search-svc filtra products WHERE status IN ('approved','platform_owned')
-- - Indice idx_products_last_sale tem partial WHERE status='approved' SOMENTE
-- - Resultado: SEQ SCAN em vez de Index Scan quando filtra recently_sold
--
-- ANTES:
--   CREATE INDEX idx_products_last_sale ON products(last_sale_at DESC NULLS LAST)
--   WHERE (status = 'approved' AND deleted_at IS NULL AND last_sale_at IS NOT NULL)
--
-- AGORA (mais inclusivo):
--   WHERE status IN ('approved','platform_owned') AND deleted_at IS NULL AND last_sale_at IS NOT NULL
--
-- Storage impact: minimal (~10 produtos hoje, idx ja existe pequeno)
-- Performance: Seq Scan -> Index Scan quando user usa filter recently_sold
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_products_last_sale_inclusive;
--   CREATE INDEX idx_products_last_sale ON products(last_sale_at DESC NULLS LAST)
--   WHERE (status = 'approved' AND deleted_at IS NULL AND last_sale_at IS NOT NULL);

DROP INDEX IF EXISTS idx_products_last_sale;

CREATE INDEX idx_products_last_sale
  ON products (last_sale_at DESC NULLS LAST)
  WHERE status IN ('approved','platform_owned')
    AND deleted_at IS NULL
    AND last_sale_at IS NOT NULL;

ANALYZE products;
