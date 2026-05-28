-- Migration 087: idxs asaas_transfer_id em seller_payouts + payouts_pending_wallet
-- W14 pass 368 - 2026-05-28
--
-- CONTEXTO:
-- Pass 282 adicionou externalReference em asaas.createTransfer p/ webhook
-- reconciliation (TRANSFER_DONE/TRANSFER_FAILED).
-- Quando esse webhook handler for implementado, lookup hot path:
--   SELECT FROM seller_payouts WHERE asaas_transfer_id = $1
--   SELECT FROM payouts_pending_wallet WHERE asaas_transfer_id = $1
--
-- LACUNA ATUAL:
-- - seller_payouts.asaas_transfer_id VARCHAR(60) SEM idx (mig 003)
-- - payouts_pending_wallet.asaas_transfer_id VARCHAR(60) SEM idx (mig 078)
-- Sem idx, webhook handler futuro faria Seq Scan em ambas tabelas:
--   - seller_payouts: ~10k-100k rows produo (1 ano N sellers)
--   - payouts_pending_wallet: smaller (~100-1k) but still seq scan waste
--   - Webhook frequencia baixa MAS latencia importante (Asaas timeout 10s)
--
-- TAMBEM:
-- UNIQUE constraint defensive - asaas_transfer_id deve ser globally unique
-- across BOTH tabelas (Asaas ID space shared). Sem UNIQUE, bug latente:
--   - Admin re-process payout que ja paid -> nova Asaas transfer dispatch
--   - 2 records no DB com mesmo asaas_transfer_id (race ou bug)
--   - Webhook reconciliation ambigua
-- PARTIAL UNIQUE WHERE NOT NULL: permite NULL (pending state) sem violar.
--
-- TRADE-OFF: 2 idx writes em CADA UPDATE asaas_transfer_id (raro, 1 per payout
-- lifecycle). Aceitavel.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_payouts_transfer_id;
--   DROP INDEX IF EXISTS idx_pending_wallet_transfer_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payouts_transfer_id
  ON seller_payouts(asaas_transfer_id)
  WHERE asaas_transfer_id IS NOT NULL;

-- payouts_pending_wallet pode nao existir em deploys antigos
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_name = 'payouts_pending_wallet') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_wallet_transfer_id
      ON payouts_pending_wallet(asaas_transfer_id)
      WHERE asaas_transfer_id IS NOT NULL;
  END IF;
END $$;

ANALYZE seller_payouts;

DO $$
BEGIN
  RAISE NOTICE 'W14-pass368: idxs asaas_transfer_id criados (UNIQUE PARTIAL p/ webhook reconcile)';
END $$;
