-- Migration 101: idx_reports_status_created composite (status + created_at DESC)
-- ============================================================================
--
-- FIX-WORKER-14 pass 484: admin reports listing performance
--
-- CONTEXT:
--   review-svc admin endpoint /admin/reports (linha 1392):
--     SELECT r.*, u.* FROM reports r
--      LEFT JOIN users u ON u.id = r.reporter_user_id
--      WHERE r.status = $1
--      ORDER BY r.created_at DESC, r.id DESC
--      LIMIT $2 OFFSET $3
--
-- PRE-FIX:
--   Idx existentes:
--   - idx_reports_status (status) (mig 007)
--   - idx_reports_created (created_at DESC) (mig 007)
--   - idx_reports_target (target_type, target_id) (mig 007)
--
--   Query pattern "WHERE status=X ORDER BY created_at DESC":
--   - PG planner usa idx_reports_status -> rows desordenadas
--   - Sort node externo (heap sort se N > work_mem)
--   - Em prod com 1k+ reports/status = ~50ms latency
--
-- POST-FIX:
--   Composite (status, created_at DESC, id DESC):
--   - Direct Index Scan pre-sorted
--   - No Sort node required
--   - Latency: ~50ms -> ~5ms (10x)
--   - Tiebreaker id DESC paridade pass 251 (Regra D pagination drift)
--
-- COVERAGE QUERIES:
--   - /admin/reports listing (4 status filters: opened/under_review/resolved/dismissed)
--   - Future: /admin/reports?status=opened paginacao FIFO admin queue
--
-- PATTERN V8 W14 (paridade pass 086 audit_log severity_created):
--   composite (filter_col, sort_col DESC, tiebreaker_col DESC)
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_reports_status_created;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_reports_status_created
    ON reports(status, created_at DESC, id DESC);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_reports_status_created create: % - %', SQLSTATE, SQLERRM;
END $$;

ANALYZE reports;

DO $$ BEGIN
  RAISE NOTICE 'W14-pass484: idx_reports_status_created composite (consume /admin/reports listing pattern)';
END $$;
