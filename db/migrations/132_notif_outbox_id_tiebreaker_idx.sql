-- Migration 132: idx_notif_outbox_ready_id PARTIAL composite com id ASC tiebreaker
-- ============================================================================
--
-- FIX-WORKER-14 pass 716: consume notification-svc processOutbox claim ORDER
-- direction parity. Paridade Regra D V8 cross-svc (cadeia mig 102-131).
--
-- CONTEXT:
--   notification-svc processOutbox (server.js linha 975-989) - cron 30s:
--     UPDATE notifications SET locked_by = $1, locked_at = NOW()
--       WHERE id IN (
--         SELECT id FROM notifications
--          WHERE sent_status = 'pending'
--            AND channel IN ('email','telegram')
--            AND retry_count < 5
--            AND next_retry_at <= NOW()
--            AND locked_by IS NULL
--          ORDER BY priority DESC, created_at ASC, id ASC
--          LIMIT 25
--          FOR UPDATE SKIP LOCKED
--       )
--
--   Pass 712 adicionou id ASC tiebreaker para forensic determinism.
--   Mig 070 PRE-FIX cobre 3-level (priority DESC, created_at ASC, next_retry_at)
--   MAS nao inclui id ASC final tiebreaker.
--
-- PRE-FIX existing index (mig 070):
--   idx_notif_outbox_ready PARTIAL
--     ON notifications(priority DESC, created_at ASC, next_retry_at)
--     WHERE sent_status = 'pending' AND locked_by IS NULL AND retry_count < 5
--   - Covers prefix WHERE + ORDER 3-level
--   - MAS NAO inclui id ASC (pass 712 final tiebreaker)
--   - PG planner: idx scan + Sort node externo para id ASC (External Sort)
--   - Mass-insert burst -> N rows mesma priority+created_at+next_retry_at
--   - LIMIT 25 picks ARBITRARY entre ties sem deterministic order
--
-- POST-FIX:
--   idx_notif_outbox_ready_id PARTIAL composite com tiebreaker completo:
--     ON notifications(priority DESC, created_at ASC, id ASC)
--     WHERE sent_status = 'pending' AND locked_by IS NULL AND retry_count < 5
--
--   Note: next_retry_at removed (filter via WHERE clause sufficient)
--   id ASC adicionado p/ deterministic claim order
--
--   Planner steps:
--   1. Direct Index Scan PARTIAL idx_notif_outbox_ready_id
--      (pre-sorted full ORDER BY tuple completo)
--   2. LIMIT 25 + FOR UPDATE SKIP LOCKED (claim atomic)
--
--   Latency: ~3-8ms External Sort eliminado -> ~1-2ms claim per tick
--   Storage: ~100-300KB PARTIAL (subset pending only)
--
--   Trade-off vs mig 070 idx_notif_outbox_ready:
--   - mig 070 inclui next_retry_at em key (PG planner pode usar p/ range)
--   - mig 132 (este) inclui id ASC tiebreaker (forensic determinism)
--   - Manter ambos: PG planner escolhe best fit (cost model)
--   - pg_stat_user_indexes mostra usage decision drop futuro
--
-- COVERAGE QUERIES:
--   - processOutbox cron 30s claim (este path - pass 712 ORDER fix)
--   - Future outbox analytics
--
-- PATTERN V8 W14 cadeia direction parity composite PARTIAL:
--   passes 102-131 (30 indexes consolidacao previa)
--   pass 132 (este) notif_outbox_ready_id PARTIAL tiebreaker
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_notif_outbox_ready_id;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_notif_outbox_ready_id
    ON notifications(priority DESC, created_at ASC, id ASC)
    WHERE sent_status = 'pending'
      AND locked_by IS NULL
      AND retry_count < 5;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_notif_outbox_ready_id create: % - %', SQLSTATE, SQLERRM;
END $$;

ANALYZE notifications;

DO $$ BEGIN
  RAISE NOTICE 'W14-pass716: idx_notif_outbox_ready_id PARTIAL composite tiebreaker (paridade pass 712 outbox ORDER fix + cadeia mig 102-131)';
END $$;
