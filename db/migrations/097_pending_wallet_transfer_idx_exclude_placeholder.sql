-- Migration 097: idx_pending_wallet_transfer_id excluir placeholder __claimed_%
-- ============================================================================
--
-- FIX-WORKER-14 pass 454: consume pass 453 claim marker pattern
--
-- CONTEXT:
--   Pass 453 introduziu placeholder pattern em payouts_pending_wallet:
--     asaas_transfer_id = '__claimed_<pid>_<timestamp>'
--   Pre-Asaas claim marker p/ prevenir race double-transfer.
--
--   Mig 087 criou idx_pending_wallet_transfer_id UNIQUE PARTIAL:
--     WHERE asaas_transfer_id IS NOT NULL
--   Esta PARTIAL clause inclui placeholders ('__claimed_%') no idx.
--
-- PRE-FIX:
--   Idx contem MIX de:
--   - Asaas transfer IDs reais (ex: 'tra_abc123xyz')
--   - Placeholders ephemeral (ex: '__claimed_42_1716985000000')
--   Issues:
--   1. Idx space wasted em placeholders (todos diferentes - cada call_marker e unique)
--   2. UNIQUE constraint protege placeholders MAS placeholders devem ser unique
--      por design (pid + timestamp). Sem real benefit.
--   3. ANALYZE statistics distorted: planner ve N entries mas N inclui
--      placeholders ephemeral (que sao limpos pos-success)
--   4. Webhook lookup WHERE asaas_transfer_id = 'tra_real' tem mesma latencia
--      MAS idx page reads + cache pollution maior que necessario
--
-- POST-FIX:
--   Recriar idx EXCLUINDO placeholder pattern:
--     WHERE asaas_transfer_id IS NOT NULL
--       AND asaas_transfer_id NOT LIKE '__claimed_%'
--   - Idx so contem real Asaas IDs (significativo p/ webhook reconcile)
--   - UNIQUE constraint apenas em transfer IDs reais (semantica correta)
--   - Idx space liberado: ~10-30% economia em deploys com ciclos cron frequentes
--   - Statistics ANALYZE preciso (planner ve apenas N transfer real)
--   - Webhook lookup latencia melhor (cache hit rate mais alto)
--
-- TRADE-OFF:
--   - Cleanup query 'WHERE asaas_transfer_id LIKE __claimed_%' (pass 453 catch path)
--     NAO usa este idx (LIKE prefix nao bate com PARTIAL exclusion).
--   - Mas: cleanup roda 1x por falha cron (raro) - Seq Scan acceptable em
--     payouts_pending_wallet (tipicamente <1k rows).
--   - Alternativa idx separate p/ placeholders: overkill, nao implementado.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_pending_wallet_transfer_id;
--   CREATE UNIQUE INDEX idx_pending_wallet_transfer_id
--     ON payouts_pending_wallet(asaas_transfer_id)
--     WHERE asaas_transfer_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_name = 'payouts_pending_wallet') THEN
    -- Drop antigo (inclui placeholders no PARTIAL WHERE)
    DROP INDEX IF EXISTS idx_pending_wallet_transfer_id;
    -- Recreate excluindo placeholders
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_wallet_transfer_id
      ON payouts_pending_wallet(asaas_transfer_id)
      WHERE asaas_transfer_id IS NOT NULL
        AND asaas_transfer_id NOT LIKE '__claimed_%';
  END IF;
END $$;

ANALYZE payouts_pending_wallet;

DO $$ BEGIN
  RAISE NOTICE 'W14-pass454: idx_pending_wallet_transfer_id recriado excluindo placeholder __claimed_%% (consume pass 453 claim marker)';
END $$;
