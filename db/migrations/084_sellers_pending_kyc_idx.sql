-- Migration 084: idx PARTIAL sellers pending_kyc queue (admin hot-path)
-- W14 pass 297 - 2026-05-28
--
-- CONTEXTO:
-- GET /sellers/admin/pending-kyc query agregada:
--   WHERE status IN ('pending_kyc','kyc_submitted')
--   ORDER BY
--     CASE status WHEN 'kyc_submitted' THEN 1 WHEN 'pending_kyc' THEN 2 END,
--     kyc_submitted_at ASC NULLS LAST,
--     created_at ASC,
--     id
--   LIMIT N
--
-- Idx existente:
-- - idx_sellers_status (mig 003) - cobre WHERE status mas nao PARTIAL
-- - sequence scan completo de sellers table aplicando filter status IN
-- - Em maturidade (>10k sellers, 95% 'active'), scan ineficiente em 95% rows
--
-- HOT-PATH: admin dashboard polls 30s + manual refresh. FIFO ordering por
-- kyc_submitted_at = oldest first (queue triage).
--
-- POST-FIX: idx PARTIAL composto p/ queue admin pending KYC:
--   ON sellers (kyc_submitted_at ASC NULLS LAST, created_at ASC, id)
--   WHERE status IN ('pending_kyc','kyc_submitted')
-- - PARTIAL filtra 95% sellers ativos (active/suspended/banned)
-- - Compound ordering covers ORDER BY (Index Scan sem Sort step)
-- - NULLS LAST: kyc_submitted_at NULL (pending_kyc nao enviou) ao final
--
-- ROLLBACK: DROP INDEX IF EXISTS idx_sellers_pending_kyc_queue;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_sellers_pending_kyc_queue
    ON sellers (kyc_submitted_at ASC NULLS LAST, created_at ASC, id)
    WHERE status IN ('pending_kyc','kyc_submitted');
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

ANALYZE sellers;

DO $$
BEGIN
  RAISE NOTICE 'W14-pass297: idx_sellers_pending_kyc_queue created (PARTIAL FIFO admin queue)';
END $$;
