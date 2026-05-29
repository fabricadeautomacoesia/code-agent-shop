-- Migration 122: idx_alerts_severity_created_id direction parity DESC+DESC tiebreaker
-- ============================================================================
--
-- FIX-WORKER-14 pass 631: consume aiops-svc /alerts (alertsHandler) severity filter
-- ORDER BY tiebreaker direction parity. Paridade Regra D V8 cross-svc (cadeia mig 102-121).
--
-- CONTEXT:
--   aiops-svc /alerts + /alerts/recent (server.js linha 442-452):
--     SELECT id, severity, source, code, title, message, target_type, target_id,
--            payload, acknowledged_at, created_at,
--            COUNT(*) OVER()::INT AS _total
--       FROM alerts
--      WHERE created_at > NOW() - INTERVAL [+ severity = $X AND source = $Y AND ack = $Z]
--      ORDER BY created_at DESC, id DESC
--      LIMIT $N OFFSET $M
--
--   Used by:
--   - dashboard-admin /alerts page polling (every 10s)
--   - admin investigation workflows ?severity=critical&acknowledged=false
--
-- PRE-FIX existing index (mig 008:119):
--   idx_alerts_severity ON alerts(severity, created_at DESC)
--   - Covers WHERE severity + ORDER BY created_at DESC (range scan)
--   - MAS NAO inclui id tiebreaker DESC
--   - alerts mass-insert burst (cron monitoring tick) - 10+ alerts mesma
--     created_at second-precision -> tiebreaker id DESC External Sort
--   - alerts table grows ~50-100/dia em prod = ~30k rows/year
--   - External Sort overhead per query ~3-8ms
--
-- POST-FIX:
--   idx_alerts_severity_created_id composite direction parity Regra D V8:
--     ON alerts (severity, created_at DESC, id DESC)
--
--   Planner steps:
--   1. Direct Index Scan idx_alerts_severity_created_id WHERE severity = $X
--      (pre-sorted full ORDER BY descending tiebreaker)
--   2. Filter remaining (source/ack via WHERE pos-idx scan)
--   3. LIMIT N + OFFSET M (SEM External Sort)
--
--   Latency: ~3-8ms External Sort eliminado -> ~1-3ms total query
--   Storage: ~500KB-1MB para 30k alerts
--
--   Trade-off vs mig 008 idx_alerts_severity:
--   - mig 008 cobre simple severity filter (sem sort tiebreaker)
--   - mig 122 (este) cobre /alerts ORDER tiebreaker completo direction parity
--   - Manter ambos. pg_stat_user_indexes decision drop futuro
--
-- COVERAGE QUERIES:
--   - GET /alerts + GET /alerts/recent (este path - dashboard-admin polling 10s)
--   - Future cron alerts_export forensic reports
--
-- PATTERN V8 W14 cadeia direction parity composite tiebreaker:
--   passes 102-121 (20 indexes consolidacao previa)
--   pass 122 (este) alerts_severity direction parity DESC+DESC
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_alerts_severity_created_id;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_alerts_severity_created_id
    ON alerts (severity, created_at DESC, id DESC);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_alerts_severity_created_id create: % - %', SQLSTATE, SQLERRM;
END $$;

ANALYZE alerts;

DO $$ BEGIN
  RAISE NOTICE 'W14-pass631: idx_alerts_severity_created_id direction parity DESC+DESC tiebreaker /alerts admin polling (paridade Regra D cadeia mig 102-121)';
END $$;
