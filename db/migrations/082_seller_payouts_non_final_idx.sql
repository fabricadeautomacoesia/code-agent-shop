-- Migration 082: idx PARTIAL seller_payouts hot-path "non_final SUM"
-- W14 pass 286 - 2026-05-28
--
-- CONTEXTO:
-- POST /sellers/me/payout faz CTE non_final SUM:
--   SELECT COALESCE(SUM(amount_cents), 0)
--     FROM seller_payouts
--    WHERE seller_id = $1
--      AND status IN ('pending','approved','processing','paid')
--
-- Idx existentes:
-- - (seller_id, requested_at DESC) - cobre WHERE seller_id mas inclui rejected/canceled
-- - (status) - cardinalidade baixa (6 valores), nao seletivo isolado
-- - (status, requested_at ASC) - admin queue scan, nao por seller
--
-- HOT-PATH: cada seller payout request faz UM scan da CTE. Em sellers ativos
-- com muito historico (>500 payouts em 12 meses), idx existente forca scan
-- de TODOS payouts mesmo rejected/canceled (50%+ noise em mature DB).
--
-- POST-FIX: idx PARTIAL com predicate static cobrindo apenas status active:
--   ON seller_payouts(seller_id, amount_cents)
--   WHERE status IN ('pending','approved','processing','paid')
-- - PARTIAL filtra rejected/canceled (finalized states never in non_final sum)
-- - amount_cents INCLUDE p/ index-only scan (sem heap visit p/ SUM)
-- - Seller com 500 payouts (300 rejected, 200 non_final) -> scan apenas 200 rows
--
-- ROLLBACK: DROP INDEX IF EXISTS idx_seller_payouts_non_final_sum;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_seller_payouts_non_final_sum
    ON seller_payouts (seller_id, amount_cents)
    WHERE status IN ('pending','approved','processing','paid');
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

ANALYZE seller_payouts;

DO $$
BEGIN
  RAISE NOTICE 'W14-pass286: idx_seller_payouts_non_final_sum created (PARTIAL non-final sum)';
END $$;
