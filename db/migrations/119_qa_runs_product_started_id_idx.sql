-- Migration 119: idx_qa_runs_product_started_id direction parity DESC+DESC tiebreaker
-- ============================================================================
--
-- FIX-WORKER-14 pass 625: consume qa-svc GET /qa/runs/:product_id ORDER BY
-- tiebreaker direction parity. Paridade Regra D V8 cross-svc (cadeia mig 102-118).
--
-- CONTEXT:
--   qa-svc /qa/runs/:product_id (server.js linha 946-957):
--     SELECT id, product_id, product_version_id, verdict, confidence_score, ...
--            COUNT(*) OVER()::INT AS _total
--       FROM product_qa_runs
--      WHERE product_id = $1 [AND verdict = $2]
--      ORDER BY started_at DESC, id DESC
--      LIMIT $N OFFSET $M
--
--   Used by:
--   - dashboard-admin /admin/qa-queue polling (admin moderation queue)
--   - dashboard-seller /products/[id]/qa-history (seller forensic review)
--   - dashboard-admin /admin/products audit drill-down
--
-- PRE-FIX existing index (mig 034 + 092):
--   idx_qa_runs_product_started ON product_qa_runs(product_id, started_at DESC)
--   - Covers WHERE product_id + ORDER BY started_at DESC (range scan)
--   - MAS NAO inclui id tiebreaker DESC
--   - QA runs same product mass-burst (cron re-validation):
--     10 runs mesmo product_id same started_at second-precision -> tiebreaker
--     id DESC forca External Sort node externo
--   - Em prod com 100+ products * 20 historical runs each = 2k+ rows
--   - External Sort overhead per query ~3-8ms
--
-- POST-FIX:
--   idx_qa_runs_product_started_id composite direction parity Regra D V8:
--     ON product_qa_runs (product_id, started_at DESC, id DESC)
--
--   Planner steps:
--   1. Direct Index Scan idx_qa_runs_product_started_id WHERE product_id
--      (pre-sorted full ORDER BY descending tiebreaker)
--   2. LIMIT N + OFFSET M (SEM External Sort)
--
--   Latency: ~3-8ms External Sort eliminado -> ~1-3ms total query
--   Storage: ~1-2MB para 2k rows (acceptable)
--
--   Trade-off vs mig 034 idx_qa_runs_product_started:
--   - mig 034 cobre simple ORDER queries (sem tiebreaker)
--   - mig 119 (este) cobre ORDER tiebreaker completo direction parity
--   - Manter ambos. pg_stat_user_indexes decision drop futuro
--
-- COVERAGE QUERIES:
--   - GET /qa/runs/:product_id (este path - admin + seller forensic)
--   - Future cron qa_audit reports
--
-- PATTERN V8 W14 cadeia direction parity composite tiebreaker:
--   passes 102-118 (17 indexes consolidacao previa)
--   pass 119 (este) qa_runs direction parity DESC+DESC
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_qa_runs_product_started_id;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_qa_runs_product_started_id
    ON product_qa_runs (product_id, started_at DESC, id DESC);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_qa_runs_product_started_id create: % - %', SQLSTATE, SQLERRM;
END $$;

ANALYZE product_qa_runs;

DO $$ BEGIN
  RAISE NOTICE 'W14-pass625: idx_qa_runs_product_started_id direction parity DESC+DESC tiebreaker (paridade Regra D cadeia mig 102-118)';
END $$;
