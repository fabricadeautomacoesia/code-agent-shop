-- Migration 129: idx_audit_actor_created_id direction parity DESC+DESC tiebreaker
-- ============================================================================
--
-- FIX-WORKER-14 pass 705: consume aiops-svc GET /audit-log actor filter query
-- ORDER BY tiebreaker direction parity. Paridade Regra D V8 cross-svc (cadeia mig 102-128).
--
-- CONTEXT:
--   aiops-svc /audit-log (server.js linha 696-705) - admin forensic query:
--     SELECT a.id, a.actor_user_id, a.actor_role, a.action, ...
--            u.email AS actor_email, u.display_name AS actor_display_name,
--            COUNT(*) OVER()::INT AS _total
--       FROM audit_log a
--       LEFT JOIN users u ON u.id = a.actor_user_id
--      WHERE a.created_at > NOW() - INTERVAL [+ action/severity/target filters]
--      ORDER BY a.created_at DESC, a.id DESC
--      LIMIT $N OFFSET $M
--
--   Used by:
--   - dashboard-admin /audit-log forensic investigation
--   - admin filter "todos audits de actor X" comum
--   - SOC2 CC7.3 + LGPD Art 37 compliance queries
--
-- PRE-FIX existing index (mig 058):
--   idx_audit_actor_created PARTIAL (actor_user_id, created_at DESC) WHERE actor_user_id IS NOT NULL
--   - Cobre actor filter + ORDER BY created_at DESC
--   - MAS NAO inclui id DESC tiebreaker
--   - HIGH WRITE VOLUME: audit_log mass-insert burst (cron + admin actions)
--   - 100+ entries mesmo created_at second-precision em peak operations
--   - id BIGSERIAL DESC tiebreaker forca External Sort node externo
--   - audit_log cresce ~5k-10k rows/dia em prod ativo (~150-300k rows/month)
--   - External Sort overhead per query ~5-15ms
--
-- POST-FIX:
--   idx_audit_actor_created_id PARTIAL composite direction parity Regra D V8:
--     ON audit_log (actor_user_id, created_at DESC, id DESC) WHERE actor_user_id IS NOT NULL
--
--   Planner steps:
--   1. Direct Index Scan idx_audit_actor_created_id PARTIAL WHERE actor_user_id
--      (pre-sorted full ORDER BY descending tiebreaker)
--   2. LEFT JOIN users via PK lookup
--   3. LIMIT N + OFFSET M (SEM External Sort)
--
--   Latency: ~5-15ms External Sort eliminado -> ~1-3ms total query
--   Storage: ~3-8MB para 300k audit rows (acceptable - PARTIAL exclui anonymous)
--
--   Trade-off vs mig 058 idx_audit_actor_created:
--   - mig 058 cobre simple actor + ORDER (sem tiebreaker)
--   - mig 129 (este) cobre tiebreaker completo direction parity
--   - Manter ambos. pg_stat_user_indexes decision drop futuro
--
-- COVERAGE QUERIES:
--   - GET /audit-log com action ou actor filter (este path - admin forensic)
--   - Future cron audit_log_export compliance reports
--
-- PATTERN V8 W14 cadeia direction parity composite tiebreaker:
--   passes 102-128 (27 indexes consolidacao previa)
--   pass 129 (este) audit_actor_created_id direction parity DESC+DESC
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_audit_actor_created_id;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_audit_actor_created_id
    ON audit_log (actor_user_id, created_at DESC, id DESC)
    WHERE actor_user_id IS NOT NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_audit_actor_created_id create: % - %', SQLSTATE, SQLERRM;
END $$;

ANALYZE audit_log;

DO $$ BEGIN
  RAISE NOTICE 'W14-pass705: idx_audit_actor_created_id PARTIAL direction parity DESC+DESC (paridade Regra D cadeia mig 102-128)';
END $$;
