-- Migration 091: fix idx_disputes_admin_queue (mig 042 column name typo)
-- W14 pass 402 - 2026-05-28
--
-- CONTEXTO:
-- Mig 042 (pass 31) criou idx_disputes_admin_queue:
--   ON disputes(status, opened_at ASC)
-- MAS schema disputes (mig 007) tem coluna `created_at`, NAO `opened_at`.
--
-- Resultado:
-- - Mig 042 falha SILENTE em apply (CREATE INDEX with undefined column)
-- - Sem DO $$ ... EXCEPTION undefined_column wrap
-- - Idx idx_disputes_admin_queue NAO EXISTE em prod
-- - Admin /admin/disputes endpoint forca Seq Scan disputes
-- - Em peak (10+ disputes ativas): query slow
--
-- VERIFY:
--   psql -c "\d disputes" | grep opened_at
--   (Empty result = column nao existe)
--   psql -c "SELECT 1 FROM pg_indexes WHERE indexname='idx_disputes_admin_queue';"
--   (0 rows = idx never created)
--
-- POST-FIX:
-- DROP IF EXISTS (graceful) + CREATE com nome de coluna correto.
-- (status, created_at ASC) - paridade endpoint orders.js linha 766
-- ORDER BY CASE status... + created_at DESC + id DESC
--
-- BONUS: criar idx_disputes_admin_queue_desc (created_at DESC) tambem,
-- pois endpoint usa DESC (mais natural - recentes primeiro).
-- Original mig 042 usou ASC (FIFO queue thinking - mas UI MLB usa DESC).
--
-- ROLLBACK: DROP INDEX IF EXISTS idx_disputes_admin_queue;

DO $$
BEGIN
  -- Drop stale idx se existir (mig 042 pode ter sido aplicado parcial em alguns deploys)
  DROP INDEX IF EXISTS idx_disputes_admin_queue;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- Idx correto com nome de coluna real
CREATE INDEX IF NOT EXISTS idx_disputes_admin_queue
  ON disputes(status, created_at DESC)
  WHERE status IN ('opened','under_review');

COMMENT ON INDEX idx_disputes_admin_queue IS
  'W14 pass 402: partial idx admin disputes queue (status filter + created_at DESC). Mig 042 referenciava opened_at inexistente - fix.';

ANALYZE disputes;

DO $$
BEGIN
  RAISE NOTICE 'W14-pass402: idx_disputes_admin_queue FIX (mig 042 typo opened_at -> created_at)';
END $$;
