-- Migration 053: ADD indices em sellers.asaas_wallet_id + asaas_customer_id (W14 pass 132)
--
-- Análise:
-- - sellers table tem 2 colunas Asaas críticas SEM índice:
--   * asaas_wallet_id (split nativo - lookup em todo payment create)
--   * asaas_customer_id (webhook reverse-lookup vendor)
-- - Hoje só 1 seller, mas quando >100 sellers seq_scan vira gargalo:
--   * payment-svc createPayment faz JOIN sellers ON id WHERE wallet_id = X
--   * webhook handler do Asaas faz lookup por customer_id
--
-- WHERE NOT NULL: maioria dos sellers nao tem wallet ate KYC + onboarding
-- completo. Partial idx economiza storage + accelera lookup ativo.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_sellers_asaas_wallet;
--   DROP INDEX IF EXISTS idx_sellers_asaas_customer;

CREATE INDEX IF NOT EXISTS idx_sellers_asaas_wallet
  ON sellers (asaas_wallet_id)
  WHERE asaas_wallet_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sellers_asaas_customer
  ON sellers (asaas_customer_id)
  WHERE asaas_customer_id IS NOT NULL;

ANALYZE sellers;
