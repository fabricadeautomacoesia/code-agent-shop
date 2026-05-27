-- Migration 023: Drop redundant idx_notif_outbox_unlocked (WORKER 18 pass 3 correction)
-- =====================================================================
-- HONEST RETRACTION:
-- A migration 022 criou idx_notif_outbox_unlocked supondo que o planner
-- escolheria ele para a query do outbox processor que filtra locked_by IS NULL.
--
-- EXPLAIN ANALYZE pos-deploy mostrou que o planner CONTINUA preferindo o
-- idx_notif_outbox_ready (criado em migration 016) - filtra channel +
-- next_retry_at via Index Cond e re-checa locked_by + sent_status + retry_count
-- como Filter cheap. A 50k rows, esse pattern continua otimo porque o WHERE
-- parcial ja elimina a maioria das rows antes do recheck.
--
-- idx_notif_outbox_unlocked virou redundante (idx_scan=0 desde criacao).
-- Mantelo significa custo de write em cada INSERT/UPDATE em notifications
-- sem benefit de read. Drop limpo.
-- =====================================================================
DO $$ BEGIN
  DROP INDEX IF EXISTS idx_notif_outbox_unlocked;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;
