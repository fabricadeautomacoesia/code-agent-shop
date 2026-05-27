-- WORKER 14 pass 1: indice parcial em notifications.locked_at para reclaim cron.
--
-- Audit pg_stat_user_tables: notifications tinha 3303 seq_scan vs 363 idx_scan.
-- EXPLAIN ANALYZE de reclaimOrphanLocks() confirmou Seq Scan a cada minuto:
--   UPDATE notifications SET locked_by = NULL ...
--    WHERE locked_at IS NOT NULL AND locked_at < NOW() - INTERVAL '5 minutes'
--
-- Em prod com 1M+ notifs, isso seria full table scan/minuto = CPU dump.
-- Indice parcial (WHERE locked_at IS NOT NULL) eh MICRO em disco
-- (apenas rows com claim ativo, normalmente <100 simultaneous) e elimina Seq Scan.
--
-- Idempotente: CREATE INDEX IF NOT EXISTS.

CREATE INDEX IF NOT EXISTS idx_notif_locked_reclaim
  ON notifications (locked_at)
  WHERE locked_at IS NOT NULL;

-- Stats: forca planner a recalcular custos com novo indice
ANALYZE notifications;
