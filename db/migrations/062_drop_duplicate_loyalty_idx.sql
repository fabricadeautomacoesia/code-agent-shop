-- Migration 062: drop duplicate idx_loyalty_user_recent
-- W14 pass 195 - 2026-05-28
--
-- CONTEXTO:
-- Migrations 010 e 011 criaram dois indices IDENTICOS:
--   idx_loyalty_user        ON loyalty_transactions(user_id, created_at DESC) [mig 010]
--   idx_loyalty_user_recent ON loyalty_transactions(user_id, created_at DESC) [mig 011]
--
-- Mesmas colunas, mesma ordem (DESC). Total redundancia:
-- - 2x storage (cada indice eh seu proprio btree)
-- - 2x WRITE overhead (cada INSERT atualiza ambos)
-- - PG planner pode escolher qualquer um (random) - inconsistencia metricas
--
-- IDENTIFICACAO: pass 190 (migration 061) documentou no comment "DUPLICATE!".
-- pass 195 (esta migration) executa o drop.
--
-- DECISAO MANTER vs DROP:
-- - MANTER idx_loyalty_user (mais antigo, mig 010 marketplace_enhancements)
-- - DROP idx_loyalty_user_recent (mais novo, mig 011 critical_indexes)
-- - Razao: idx_loyalty_user JOIN com nome mais semantico (user-listing).
--
-- IMPACT:
-- - Zero queries quebram (idx_loyalty_user cobre identicamente)
-- - Storage: ~10MB economia tipica (depende volume)
-- - Write perf: -50% INSERT overhead em loyalty_transactions
--   (1 idx update vs 2 antes - apenas neste BTree composite)
-- - Ainda existe idx_loyalty_idempotency (mig 061) - separate purpose
--
-- ROLLBACK:
--   CREATE INDEX idx_loyalty_user_recent ON loyalty_transactions(user_id, created_at DESC);

-- Verifica que idx_loyalty_user EXISTS antes de drop redundante
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname = 'idx_loyalty_user'
  ) THEN
    DROP INDEX IF EXISTS idx_loyalty_user_recent;
    RAISE NOTICE 'W14-pass195: idx_loyalty_user_recent dropped (duplicate of idx_loyalty_user).';
  ELSE
    RAISE WARNING 'W14-pass195: idx_loyalty_user NOT found - skip drop redundante p/ safety.';
    RAISE WARNING 'Investigar manualmente:';
    RAISE WARNING '  SELECT indexname FROM pg_indexes WHERE tablename = ''loyalty_transactions'';';
  END IF;
END $$;
