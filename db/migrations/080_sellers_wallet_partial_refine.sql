-- Migration 080: refine PARTIAL idx sellers.asaas_wallet_id excluindo empty string
-- W18 pass 278 - 2026-05-28
--
-- CONTEXTO:
-- Mig 053 criou idx_sellers_asaas_wallet PARTIAL WHERE asaas_wallet_id IS NOT NULL.
-- Pass 278 W11 enrijeceu queries (cart/admin/cron) para tambem rejeitar empty string ''
-- como wallet valida (admin clear pode setar '' em vez de NULL).
-- Idx ainda funciona como antes (predicate IS NOT NULL inclui ''), mas:
-- - Idx leaves contem rows '' que NUNCA seriam used (queries filtram <> '')
-- - Index bloat residual + planner stats off
--
-- POST-FIX: DROP + recreate idx com predicate IS NOT NULL AND <> '' p/
-- - Cron payment-svc liquidatePendingWalletPayouts JOIN sellers (mais seletivo)
-- - Cart GET seller_wallet_configured flag (cart.js pass 278)
-- - Admin /payouts-pending-wallet flag wallet_configured (admin.js pass 278)
-- - product-svc createProduct seller eligibility check (futuro pass)
--
-- IMPACT: index size shrink em ambientes onde admin limpa wallet via UI
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_sellers_asaas_wallet_valid;
--   CREATE INDEX idx_sellers_asaas_wallet ON sellers(asaas_wallet_id) WHERE asaas_wallet_id IS NOT NULL;

DROP INDEX IF EXISTS idx_sellers_asaas_wallet;
CREATE INDEX IF NOT EXISTS idx_sellers_asaas_wallet_valid
  ON sellers (asaas_wallet_id)
  WHERE asaas_wallet_id IS NOT NULL AND asaas_wallet_id <> '';

ANALYZE sellers;

DO $$
BEGIN
  RAISE NOTICE 'W18-pass278: idx_sellers_asaas_wallet_valid refined (excludes empty string)';
END $$;
