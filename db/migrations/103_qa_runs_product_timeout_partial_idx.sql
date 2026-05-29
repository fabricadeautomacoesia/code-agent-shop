-- Migration 103: idx_qa_runs_product_timeout PARTIAL (timeout_count hot path)
-- ============================================================================
--
-- FIX-WORKER-18 pass 500: consume admin /qa-queue LATERAL tc subquery
--
-- CONTEXT:
--   /admin/qa-queue endpoint (product-svc/routes/admin.js linha 148-152):
--     LEFT JOIN LATERAL (
--       SELECT COUNT(*)::INT AS timeout_count
--         FROM product_qa_runs
--        WHERE product_id = p.id AND verdict = 'timeout'
--     ) tc ON TRUE
--
--   Cache 30s + COUNT OVER() ja consolidated (pass 301 + 448).
--   Endpoint admin dashboard /admin/qa-queue poll 30s + manual refreshes.
--   Per request: 50 LATERAL invocations (LIMIT default) - cada uma COUNT
--   em product_qa_runs por product.
--
-- PRE-FIX existing indexes:
--   - idx_qa_runs_product       (product_id, created_at DESC)  -- mig 005
--   - idx_qa_runs_verdict       (verdict)                       -- mig 005
--   - idx_qa_runs_product_started (product_id, started_at DESC) -- mig 034
--   - idx_product_qa_runs_*     (FK indexes mig 049)
--
--   Planner choices for `WHERE product_id = X AND verdict = 'timeout'`:
--   - Bitmap idx_qa_runs_product (scope X) + Heap Filter verdict='timeout'
--   - Para products com 50+ runs (test product cron retry burst): scan
--     50 rows + filter -> COUNT timeout subset
--   - Para products com 1000+ runs (acumulated history): wasteful filter
--
-- POST-FIX:
--   idx_qa_runs_product_timeout PARTIAL composite:
--     ON product_qa_runs (product_id)
--     WHERE verdict = 'timeout'
--
--   Planner:
--   - Index Only Scan (idx covering product_id - tudo necessario para COUNT)
--   - Predicate verdict='timeout' immutable - planner valida pre-scan
--   - Para products SEM timeouts: idx vazio para esse product_id - COUNT=0 fast
--   - Para products COM timeouts: scan apenas rows timeout (subset pequeno)
--
--   Tamanho fisico: timeout runs sao raros (cron pass 7 detecta >10min stuck)
--   - Em prod normal: <1% dos qa_runs sao timeout
--   - Para 100k qa_runs total -> ~1k timeout rows
--   - Idx PARTIAL ~50KB (vs idx_qa_runs_product full ~10MB)
--
-- COVERAGE QUERIES:
--   - /admin/qa-queue tc LATERAL (50 invocations per request)
--   - Future: cron alert se timeout_count > threshold por product
--
-- PATTERN V8 W18 PARTIAL paridade pass 481/486/102:
--   PARTIAL com predicate literal immutable (verdict enum)
--   Tabela ALTA escrita (qa_runs cron + QA pipeline) mas idx hot pequeno
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_qa_runs_product_timeout;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_qa_runs_product_timeout
    ON product_qa_runs(product_id)
    WHERE verdict = 'timeout';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_qa_runs_product_timeout create: % - %', SQLSTATE, SQLERRM;
END $$;

ANALYZE product_qa_runs;

DO $$ BEGIN
  RAISE NOTICE 'W18-pass500: idx_qa_runs_product_timeout PARTIAL (consume /admin/qa-queue tc LATERAL)';
END $$;
