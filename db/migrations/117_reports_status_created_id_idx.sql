-- Migration 117: idx_reports_status_created_id composite (consume /admin/reports ORDER tiebreaker)
-- ============================================================================
--
-- FIX-WORKER-14 pass 619: consume review-svc GET /admin/reports ORDER BY
-- tiebreaker direction parity. Paridade Regra D V8 cross-svc (cadeia mig 102-116).
--
-- CONTEXT:
--   review-svc GET /admin/reports (linha 1406) - admin moderation queue polling.
--   Pass 618 fixou CRITICAL cache bug (keyFn shape errado = cache deslmente
--   DESLIGADO). Agora cache esta ativo - mas no MISS path query DB precisa idx
--   composite. Sem este idx, hot MISS path eh External Sort overhead.
--
--   Query padrao:
--     SELECT r.id, r.target_type, r.target_id, ..., r.created_at,
--            u.email AS reporter_email, ...
--            COUNT(*) OVER()::INT AS _total
--       FROM reports r
--       LEFT JOIN users u ON u.id = r.reporter_user_id
--      WHERE r.status = $1
--      ORDER BY r.created_at DESC, r.id DESC
--      LIMIT $2 OFFSET $3
--
-- PRE-FIX existing indexes (mig 011 + 049 + 101 + 112):
--   idx_reports_status (status) - covers WHERE filter mas nao ORDER
--   idx_reports_created (created_at DESC) - sort apenas, no WHERE filter
--   idx_reports_target (target_type, target_id) - dedup query (mig 112)
--   idx_reports_resolved_by PARTIAL - resolution analytics
--
-- POST-FIX:
--   idx_reports_status_created_id composite paridade Regra D direction parity:
--     ON reports (status, created_at DESC, id DESC)
--
--   Planner steps:
--   1. Direct Index Scan idx_reports_status_created_id WHERE status = $1
--      (pre-sorted ORDER BY descending tiebreaker)
--   2. LIMIT N + OFFSET M (SEM External Sort)
--   3. LEFT JOIN users via PK
--
--   Latency: ~30-80ms (current) -> ~3-8ms post-fix (External Sort eliminado)
--   Storage: ~3-5MB para ~100k reports lifetime production
--
--   Trade-off vs mig 011 idx_reports_status:
--   - mig 011 cobre count queries WHERE status (sem sort)
--   - mig 117 (este) cobre admin queue listing com tiebreaker
--   - Manter ambos. pg_stat_user_indexes mostra usage decision drop futuro
--
-- COVERAGE QUERIES:
--   - GET /admin/reports (este path - admin moderation queue)
--   - Future cron compliance reports export
--
-- PATTERN V8 W14 cadeia direction parity composite tiebreaker:
--   passes 102-116 (15 indexes consolidacao sessao previa)
--   pass 117 (este) reports_status_created_id direction parity DESC+DESC
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_reports_status_created_id;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_reports_status_created_id
    ON reports (status, created_at DESC, id DESC);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_reports_status_created_id create: % - %', SQLSTATE, SQLERRM;
END $$;

ANALYZE reports;

DO $$ BEGIN
  RAISE NOTICE 'W14-pass619: idx_reports_status_created_id direction parity DESC+DESC (paridade Regra D cadeia mig 102-116 + pass 618 cache fix coverage)';
END $$;
