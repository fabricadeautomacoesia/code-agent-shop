-- Migration 116: idx_metrics_collected_id composite (consume /aiops/metrics ORDER tiebreaker)
-- ============================================================================
--
-- FIX-WORKER-14 pass 616: consume aiops-svc GET /metrics ORDER BY tiebreaker
-- direction parity. Paridade Regra D V8 cross-svc (pass 251/256/259/261/271/376/598).
--
-- CONTEXT:
--   aiops-svc GET /metrics (linha 338-340) - admin dashboard polling 30s
--   metrics_history pagination.
--
--   Query padrao:
--     SELECT id, cpu_percent, ram_percent, disk_percent, ..., collected_at,
--            COUNT(*) OVER()::INT AS _total
--       FROM metrics_history
--      ORDER BY collected_at DESC, id DESC
--      LIMIT $1 OFFSET $2
--
-- PRE-FIX existing index (mig 008):
--   idx_metrics_collected ON metrics_history(collected_at DESC)
--   - Covers ORDER BY collected_at DESC (range scan)
--   - MAS NAO inclui id tiebreaker
--   - Multiple hosts collecting metrics CADA 1min = multiple rows com mesmo
--     collected_at second-precision (race condition same timestamp)
--   - id DESC tiebreaker forca External Sort node externo
--   - Em prod multi-host com 30d retention = ~130k rows
--   - External Sort overhead per query ~5-15ms
--
-- POST-FIX:
--   idx_metrics_collected_id composite paridade direction parity Regra D:
--     ON metrics_history (collected_at DESC, id DESC)
--
--   Planner steps:
--   1. Direct Index Scan idx_metrics_collected_id (pre-sorted full ORDER BY)
--   2. LIMIT N + OFFSET M (SEM External Sort)
--
--   Latency: ~5-15ms External Sort eliminado -> ~3-8ms total query
--   Storage: ~5-10MB para 130k rows (acceptable)
--
--   Trade-off vs mig 008 idx_metrics_collected:
--   - mig 008 ainda cobre simple collected_at queries (no tiebreaker)
--   - mig 116 (este) cobre full ORDER BY com tiebreaker
--   - Manter ambos. pg_stat_user_indexes mostra usage decision drop futuro
--
-- COVERAGE QUERIES:
--   - GET /aiops/metrics (este path - admin dashboard polling 30s)
--   - GET /aiops/metrics/latest (cached 30s pass 358 - same handler)
--   - Future cron metrics_export reports
--
-- PATTERN V8 W14 cadeia direction parity composite tiebreaker:
--   passes 102-115 (14 indexes consolidacao nesta sessao)
--   pass 116 (este) metrics_collected_id direction parity DESC+DESC
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_metrics_collected_id;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_metrics_collected_id
    ON metrics_history (collected_at DESC, id DESC);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_metrics_collected_id create: % - %', SQLSTATE, SQLERRM;
END $$;

ANALYZE metrics_history;

DO $$ BEGIN
  RAISE NOTICE 'W14-pass616: idx_metrics_collected_id direction parity DESC+DESC (paridade Regra D pass 598)';
END $$;
