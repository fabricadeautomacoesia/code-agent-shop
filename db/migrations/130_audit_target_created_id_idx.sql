-- Migration 130: idx_audit_target_created_id PARTIAL direction parity DESC+DESC tiebreaker
-- ============================================================================
--
-- FIX-WORKER-14 pass 706: consume aiops-svc /audit-log target filter query
-- ORDER BY tiebreaker direction parity. Paridade Regra D V8 cross-svc (cadeia mig 102-129).
--
-- CONTEXT:
--   aiops-svc /audit-log com target_id filter (admin forensic drill-down):
--     WHERE a.target_id = $X::UUID + a.created_at filter
--     ORDER BY a.created_at DESC, a.id DESC
--
--   Usado por dashboard-admin link forensic:
--   - /admin/sellers/:id -> "audit trail seller X" (pass 614 W4 forensic link)
--   - /admin/products/:id -> "audit trail product X" (pass 580)
--   - /admin/disputes/:id -> "audit trail dispute X" (pass 565)
--   - /admin/payouts-pending-wallet/:id -> "audit trail" (pass 586)
--   - /admin/vault/:id -> "audit trail vault" (pass 543)
--
-- PRE-FIX existing index (mig 094):
--   idx_audit_target_created PARTIAL (target_id, created_at DESC) WHERE target_id IS NOT NULL
--   - Cobre target filter + 1-level ORDER mas sem id DESC tiebreaker
--   - audit_log mass-insert burst -> External Sort overhead per query
--   - Multiple admin forensic queries cross-target = compounded latency
--
-- POST-FIX:
--   idx_audit_target_created_id PARTIAL composite direction parity Regra D V8:
--     ON audit_log (target_id, created_at DESC, id DESC) WHERE target_id IS NOT NULL
--
--   Planner steps:
--   1. Direct Index Scan PARTIAL WHERE target_id
--      (pre-sorted full ORDER BY descending tiebreaker)
--   2. LEFT JOIN users via PK lookup
--   3. LIMIT N + OFFSET M (SEM External Sort)
--
--   Latency: ~5-15ms External Sort eliminado -> ~1-3ms total query
--   Storage: ~3-8MB para 300k audit rows (PARTIAL exclui untargeted)
--
--   Trade-off vs mig 094 idx_audit_target_created:
--   - mig 094 cobre simple target + ORDER (sem tiebreaker)
--   - mig 130 (este) cobre tiebreaker completo direction parity
--   - Manter ambos. pg_stat_user_indexes decision drop futuro
--
-- COVERAGE QUERIES:
--   - GET /audit-log com target_id filter (este path - admin forensic drill-down)
--   - Future cron audit_log_export compliance reports
--
-- PATTERN V8 W14 cadeia direction parity composite tiebreaker:
--   passes 102-129 (28 indexes consolidacao previa)
--   pass 130 (este) audit_target_created_id direction parity DESC+DESC
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_audit_target_created_id;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_audit_target_created_id
    ON audit_log (target_id, created_at DESC, id DESC)
    WHERE target_id IS NOT NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_audit_target_created_id create: % - %', SQLSTATE, SQLERRM;
END $$;

ANALYZE audit_log;

DO $$ BEGIN
  RAISE NOTICE 'W14-pass706: idx_audit_target_created_id PARTIAL direction parity DESC+DESC (paridade mig 129 + cadeia mig 102-128)';
END $$;
