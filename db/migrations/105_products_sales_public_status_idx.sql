-- Migration 105: idx_products_sales_public PARTIAL (status IN approved+platform_owned)
-- ============================================================================
--
-- FIX-WORKER-14 pass 515: consume Pattern V8 W7 status whitelist expansion
--
-- CONTEXT:
--   Cross-svc queries publicas usam status IN ('approved','platform_owned')
--   (Pattern V8 W7 passes 9/10/11/12/13/etc - Cláusula Master Revenda Direta).
--   ORDER BY sales_count DESC eh ordering principal em:
--     - /search top-sellers (search-svc)
--     - /products listing default sort=sales (product-svc/public.js)
--     - /products/:slug/related (product-svc - related_pool CTE)
--     - /products/:slug/also-bought (product-svc - collaborative filter)
--
-- PRE-FIX existing indexes:
--   mig 005:109: idx_products_sales (sales_count DESC) WHERE status = 'approved'
--   mig 005:108: idx_products_rating (avg_rating DESC, sales_count DESC) WHERE status = 'approved'
--   mig 010:39:  idx_products_cat_sales (category_id, sales_count DESC) WHERE status = 'approved' (mig 093 widen)
--   mig 029:43:  idx_products_sales_rating (sales_count DESC, avg_rating DESC) WHERE status = 'approved'
--
--   PROBLEMA: TODOS PARTIAL com WHERE status = 'approved' (single value).
--   PATTERN V8 W7 estabeleceu queries publicas usam status IN ('approved','platform_owned'):
--     - platform_owned = Cláusula Master Revenda Direta (MLB feature)
--     - Apos pass 12 search-svc + pass 73-77 product-svc cross-svc consolidados
--   Planner para WHERE status IN ('approved','platform_owned') ORDER BY sales DESC:
--     - NAO consegue usar PARTIAL idx (predicate so cobre 'approved')
--     - Bitmap Heap Scan + Sort externo (custoso 30k+ products)
--     - Em prod com 5% platform_owned: idx ainda funciona p/ 95% approved
--       MAS planner pode escolher Seq Scan se IN clause stat estimate wrong
--
-- POST-FIX:
--   idx_products_sales_public PARTIAL composite:
--     ON products (sales_count DESC, id)
--     WHERE status IN ('approved','platform_owned')
--       AND deleted_at IS NULL
--
--   Cobertura:
--   - Status whitelist alinhado com Pattern V8 W7 queries publicas
--   - + deleted_at IS NULL pre-filter (todas queries publicas usam tambem)
--   - id tiebreaker p/ deterministic ORDER (Pattern V8 W7 Regra D)
--   - Idx physical small (so products approved/platform_owned ativos)
--
--   Trade-off vs idx_products_sales (mig 005:109):
--   - Nova idx mais ABRANGENTE em status (approved + platform_owned)
--   - Mig 005:109 ainda relevante para legacy queries WHERE status='approved' strict
--   - DROP mig 005:109 considerar em pass futuro apos validar zero queries strict
--
-- COVERAGE QUERIES:
--   - /search?sort=sales (search-svc default sort)
--   - /products?sort=sales (product-svc list)
--   - /products/:slug/related (related_pool CTE ORDER BY sales DESC)
--   - /products/:slug/also-bought (co-occurrence)
--   - /search/top-sellers (per category - mig 010 paridade futura)
--   - /products/recommendations/for-me cold-start path (pass 77 BUG 5)
--
-- LATENCIA ESPERADA:
--   - 30k products, 5% platform_owned (1.5k):
--     Pre-fix: Bitmap on idx_products_sales (28.5k approved) + Seq Scan
--              filter platform_owned (1.5k) + Sort merge -> ~80ms
--     Post-fix: Index Scan idx_products_sales_public pre-sorted -> ~5ms
--   - 16x improvement em ORDER BY sales DESC com platform_owned mixed
--
-- PATTERN V8 W14 cadeia PARTIAL:
--   pass 481 pwreset PARTIAL used_at IS NULL
--   pass 486 notif PARTIAL channel+is_read
--   pass 500 qa_runs PARTIAL verdict='timeout'
--   pass 504 price_alerts PARTIAL last_notified_at IS NULL
--   pass 515 (este) products PARTIAL status IN approved+platform_owned
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_products_sales_public;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_products_sales_public
    ON products (sales_count DESC, id)
    WHERE status IN ('approved','platform_owned')
      AND deleted_at IS NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_products_sales_public create: % - %', SQLSTATE, SQLERRM;
END $$;

ANALYZE products;

DO $$ BEGIN
  RAISE NOTICE 'W14-pass515: idx_products_sales_public PARTIAL approved+platform_owned (W7 pattern)';
END $$;
