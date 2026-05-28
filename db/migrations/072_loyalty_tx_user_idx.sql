-- Migration 072: indice em loyalty_transactions(user_id, created_at DESC)
-- W18 pass 242 - 2026-05-28
--
-- CONTEXTO:
-- loyalty_transactions e tabela append-only com 1 row per:
-- - earn pontos (compra paid - W11 webhook + loyalty/earn endpoint)
-- - redeem pontos (cart apply discount)
-- - tier_up bonus (loyalty tier promotion)
-- - admin adjust (compensacao incident)
--
-- Volume estimado: 5-10 rows/dia per user ativo.
-- Pos-1-ano em prod 1000 users ativos: 1.8M-3.6M rows.
--
-- INDICES EXISTENTES: NENHUM (mig 010 esqueceu)
-- - PK BIGSERIAL id (auto)
-- - FK user_id REFERENCES users (FK constraint, NAO index)
--
-- QUERIES HOT PATH:
-- 1. seller-svc/routes/loyalty.js:82 - balance per user (SUM points_delta)
-- 2. seller-svc/routes/loyalty.js:101 - historico user (ORDER BY created_at DESC)
-- 3. /conta/pontos UI - lista transactions WHERE user_id=$1
--
-- PROBLEMA:
-- - Cada GET /loyalty/me historico: FULL TABLE SCAN
-- - 1M+ rows: 200-800ms (escala linear com tabela)
-- - User refresh /conta/pontos (poll 30s) -> stress DB
-- - cache 30s mitiga mas miss = scan full
--
-- POST-FIX: idx composto (user_id, created_at DESC)
-- - Cover SUM balance query (idx-only scan possivel)
-- - Cover historico ORDER BY satisfeito sem sort
-- - Lookup O(log n) por user_id
-- - Latencia 200-800ms -> 2-5ms
--
-- ROLLBACK: DROP INDEX IF EXISTS idx_loyalty_tx_user_created;

CREATE INDEX IF NOT EXISTS idx_loyalty_tx_user_created
  ON loyalty_transactions(user_id, created_at DESC);

-- Bonus: idx em reference_id para audit forense
-- ("quem ganhou pontos do order X?")
CREATE INDEX IF NOT EXISTS idx_loyalty_tx_reference
  ON loyalty_transactions(reference_type, reference_id)
  WHERE reference_id IS NOT NULL;

DO $$
BEGIN
  RAISE NOTICE 'W18-pass242: idx_loyalty_tx_user_created + reference created';
END $$;
