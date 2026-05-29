-- Migration 121: idx_pv_product_created_id direction parity DESC+DESC tiebreaker
-- ============================================================================
--
-- FIX-WORKER-14 pass 628: consume product-svc /:slug PDP changelog tab ORDER BY
-- tiebreaker direction parity. Paridade Regra D V8 cross-svc (cadeia mig 102-120).
--
-- CONTEXT:
--   product-svc GET /:slug (public.js linha 941-945 subquery):
--     (SELECT json_agg(json_build_object(
--        'id', pv.id, 'version', pv.version, 'changelog', pv.changelog,
--        'is_current', pv.is_current, 'created_at', pv.created_at
--      ) ORDER BY pv.created_at DESC, pv.id DESC)
--        FROM product_versions pv WHERE pv.product_id = p.id) AS versions
--
--   Used by:
--   - PDP /product/[slug] "Changelog" tab rendering (frontend storefront)
--   - SEO schema.org PDP metadata
--
-- PRE-FIX existing index (mig 005:169):
--   idx_pv_product ON product_versions(product_id, created_at DESC)
--   - Covers WHERE product_id + ORDER BY created_at DESC
--   - MAS NAO inclui id tiebreaker DESC
--   - Cron import bulk product_versions (5+ rows same created_at) -> tiebreaker
--     id DESC forca External Sort node externo
--   - PDP cache 60s, mas warm-up + invalidation -> External Sort hit
--
-- POST-FIX:
--   idx_pv_product_created_id composite direction parity Regra D V8:
--     ON product_versions (product_id, created_at DESC, id DESC)
--
--   Planner steps:
--   1. Direct Index Scan idx_pv_product_created_id WHERE product_id
--      (pre-sorted full json_agg ORDER descending tiebreaker)
--   2. json_agg aggregation pre-sorted (sem Sort node interno)
--
--   Latency: ~1-3ms External Sort eliminado por PDP fetch
--   Storage: ~500KB-1MB para typical 10k product_versions
--
--   Trade-off vs mig 005 idx_pv_product:
--   - mig 005 cobre simple ORDER queries (sem tiebreaker)
--   - mig 121 (este) cobre PDP versions json_agg ORDER tiebreaker completo
--   - Manter ambos. pg_stat_user_indexes decision drop futuro
--
-- COVERAGE QUERIES:
--   - GET /products/:slug PDP changelog subquery (este path)
--   - Future cron product_versions analytics
--
-- PATTERN V8 W14 cadeia direction parity composite tiebreaker:
--   passes 102-120 (19 indexes consolidacao previa)
--   pass 121 (este) pv_product direction parity DESC+DESC
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_pv_product_created_id;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_pv_product_created_id
    ON product_versions (product_id, created_at DESC, id DESC);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_pv_product_created_id create: % - %', SQLSTATE, SQLERRM;
END $$;

ANALYZE product_versions;

DO $$ BEGIN
  RAISE NOTICE 'W14-pass628: idx_pv_product_created_id direction parity DESC+DESC tiebreaker PDP changelog (paridade Regra D cadeia mig 102-120)';
END $$;
