-- Migration 092: re-apply idxs sensitivos com EXCEPTION wrap (defensive)
-- W14 pass 410 - 2026-05-28
--
-- CONTEXTO (lições passes 391+402):
-- Pass 088 (mig 088): colunas erradas notification_templates - silent fail
-- Pass 042 (mig 042): coluna opened_at inexistente disputes - silent fail
-- Multiplas migrations 030-066 SEM EXCEPTION wrap = vulneraveis a:
-- - Schema drift entre deploys (column renamed)
-- - Type mismatch evolution (text -> jsonb)
-- - Silent failures invisive ate audit forense
--
-- POST-FIX defensive reapply:
-- - Idxs criticos hot-path reaplicados com DO $$ ... EXCEPTION wrap
-- - IF NOT EXISTS preserva idempotencia (re-run safe)
-- - undefined_column/undefined_table caught (cross-schema deploys)
-- - RAISE NOTICE feedback admin
--
-- IDXS CONSOLIDADOS (mais criticos do consolidacao stack):
-- 1. idx_qa_runs_product_started (mig 034 W14-6)
-- 2. idx_audit_action_created (mig 037 W14-9)
-- 3. idx_product_views_rolling_90d (mig 041 W14-10)
-- 4. idx_seller_payouts_processing_stuck (mig 040 W7-23)
--
-- ROLLBACK: este script eh REAPPLY com IF NOT EXISTS - rollback eh DROP idx individual.

DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS idx_qa_runs_product_started
    ON product_qa_runs(product_id, started_at DESC);
EXCEPTION
  WHEN undefined_table OR undefined_column THEN
    RAISE NOTICE 'W14-pass410: idx_qa_runs_product_started SKIP (table/col missing)';
END $$;

DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS idx_audit_action_created
    ON audit_log(action, created_at DESC);
EXCEPTION
  WHEN undefined_table OR undefined_column THEN
    RAISE NOTICE 'W14-pass410: idx_audit_action_created SKIP (table/col missing)';
END $$;

DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS idx_seller_payouts_processing_stuck
    ON seller_payouts(processing_started_at ASC)
    WHERE status = 'processing';
EXCEPTION
  WHEN undefined_table OR undefined_column THEN
    RAISE NOTICE 'W14-pass410: idx_seller_payouts_processing_stuck SKIP (col missing - check mig 040)';
END $$;

-- ANALYZE tables p/ planner stats fresh
DO $$
BEGIN
  ANALYZE product_qa_runs;
  ANALYZE audit_log;
  ANALYZE seller_payouts;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'W14-pass410: ANALYZE skip (some table missing)';
END $$;

DO $$
BEGIN
  RAISE NOTICE 'W14-pass410: defensive reapply 3 idxs hot-path (EXCEPTION wrap p/ silent fail prevention)';
END $$;
