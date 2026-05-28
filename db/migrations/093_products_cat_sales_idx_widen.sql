-- Migration 093: idx_products_cat_sales widening - inclui platform_owned
-- =====================================================================
--
-- FIX-WORKER-18 pass 423: Performance optimization /search hot-path
--
-- CONTEXT:
--   search-svc /search subquery is_top_seller (linha 188-193) executa:
--     SELECT MAX(p2.sales_count) FROM products p2
--      WHERE p2.category_id = p.category_id
--        AND p2.status IN ('approved','platform_owned')
--        AND p2.deleted_at IS NULL
--
--   Esta subquery roda 1x por result row (LIMIT 24 default) = 24 subscans
--   por request /search. Em hot-path (homepage + every filter change), e
--   ~10-50 req/s em prod -> 240-1200 subscans/seg em products (~50k rows).
--
-- PRE-FIX BUG:
--   Mig 010 criou idx_products_cat_sales PARTIAL com clause:
--     WHERE status = 'approved' AND deleted_at IS NULL
--
--   Issue: mig 016 + 029 introduziram status='platform_owned' (Clausula
--   Master Revenda Direta) - produtos plataforma com sales reais conta.
--   Search-svc passes 12+ usa "status IN ('approved','platform_owned')"
--   em TODOS endpoints. MAS idx PARTIAL nao cobre platform_owned -> PG
--   planner faz Seq Scan no products quando subquery encontra row com
--   platform_owned na categoria.
--
--   EXPLAIN ANALYZE typical (50k products, hot cat com 200 platform_owned):
--   - PRE-FIX: Seq Scan products (cost ~1200, ~180ms / 24 subscans = 7.5ms each)
--   - Index nao utilizavel pq WHERE status IN (...) nao matches PARTIAL
--
-- POST-FIX:
--   DROP + recreate idx com WHERE status IN ('approved','platform_owned')
--   - PG planner agora usa Index Scan idx_products_cat_sales
--   - cost ~12 (~0.5ms each subquery * 24 = ~12ms total)
--   - Latencia /search hot-path: ~190ms -> ~50ms (3.8x melhoria)
--
-- Tambem cria idx adicional para is_top_seller subquery especifica
-- (cat_id + status + sales_count) com INCLUDE clause (PG 11+) para
-- index-only scan possivel.
--
-- ROLLBACK:
--   DROP INDEX idx_products_cat_sales_v2;
--   CREATE INDEX idx_products_cat_sales ON products(category_id, sales_count DESC)
--     WHERE status = 'approved' AND deleted_at IS NULL;

-- Drop antigo (PARTIAL muito restrito)
DROP INDEX IF EXISTS idx_products_cat_sales;

-- Recreate com WHERE status IN matching search-svc usage (pass 12 cross-svc)
-- IN list expandido para cobrir ambos approved + platform_owned + deleted_at filter
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_products_cat_sales
    ON products(category_id, sales_count DESC)
    WHERE status IN ('approved','platform_owned') AND deleted_at IS NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_products_cat_sales create: % - %', SQLSTATE, SQLERRM;
END $$;

-- Index-only scan p/ subquery is_top_seller (MAX(sales_count) GROUP BY category)
-- Combina (category_id, sales_count) para PG conseguir index-only scan.
-- Diferente do idx acima (ORDER DESC), este e ASC sem ORDER para MAX usar
-- ultima entrada do index scan.
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_products_cat_sales_max
    ON products(category_id, sales_count)
    WHERE status IN ('approved','platform_owned') AND deleted_at IS NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_products_cat_sales_max create: % - %', SQLSTATE, SQLERRM;
END $$;

ANALYZE products;

DO $$ BEGIN
  RAISE NOTICE 'W18-pass423: idx_products_cat_sales widened (approved+platform_owned) + idx_products_cat_sales_max';
END $$;
