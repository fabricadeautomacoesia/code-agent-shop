-- ============================================================
-- Migration 040: seller_payouts.processing_started_at + idx
-- FIX-WORKER-7 pass 23: suporte a state 'processing' (anti-race + cron reconcile)
-- ============================================================
-- CONTEXTO:
--   W7 pass 23 introduziu state 'processing' em seller_payouts entre 'approved'
--   e 'paid' para mitigar race condition duplo-process:
--   1. Admin A FOR UPDATE -> status='approved' -> UPDATE 'processing'
--   2. Admin B FOR UPDATE -> aguarda lock -> status='processing' -> rejeita
--   3. Admin A: createTransfer Asaas (fora tx, demorado)
--   4. Admin A: UPDATE 'paid' + asaas_transfer_id
--
--   Falha entre 3 e 4 (restart, network) deixa payout 'processing' stuck.
--   Cron reconcile detecta processing_started_at > 5min e ALERTA admin
--   p/ investigacao manual (transfer pode ter executado no Asaas).
--
-- ============================================================

-- 1. ADD COLUMN processing_started_at
ALTER TABLE seller_payouts
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;

COMMENT ON COLUMN seller_payouts.processing_started_at IS
  'FIX-W7-23: timestamp inicio fase 2 (Asaas API call). NULL = nunca processado. NOT NULL + status=processing > 5min = stuck (cron alerta).';

-- 2. PARTIAL IDX p/ cron reconcile detectar stuck
-- Cron job futuro:
--   SELECT id, seller_id, amount_cents FROM seller_payouts
--    WHERE status = 'processing' AND processing_started_at < NOW() - INTERVAL '5 minutes'
-- Idx parcial cobre so rows relevantes (raros - processing eh estado transitorio).
CREATE INDEX IF NOT EXISTS idx_seller_payouts_processing_stuck
  ON seller_payouts(processing_started_at ASC)
  WHERE status = 'processing';

COMMENT ON INDEX idx_seller_payouts_processing_stuck IS
  'FIX-W7-23: partial idx p/ cron detectar payouts stuck > 5min em fase Asaas API.';

-- 3. COMMENT ON TABLE atualiza state machine docs
COMMENT ON TABLE seller_payouts IS
  'Solicitacoes de saque. Lifecycle: pending -> approved -> processing -> paid|failed. Status processing = Asaas API call ativa (cron reconcile detecta > 5min).';

-- ============================================================
-- DEPLOY ORDER:
--   1. Apply migration 040 (cron migration runner auto-pickup)
--   2. Deploy payment-svc rebuild (codigo W7 pass 23 usa col nova)
--   3. Schema-first safe: codigo SEM coluna = ERROR PG explicit
--      (vs falha silenciosa se rodar codigo antes migration)
-- ============================================================
