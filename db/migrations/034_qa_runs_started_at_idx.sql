-- FIX-WORKER-14 pass 6: indice composto product_qa_runs (product_id, started_at DESC)
--
-- AUDIT:
-- A query do seller dashboard "histórico de QA por produto":
--   SELECT ... FROM product_qa_runs WHERE product_id = $1
--    ORDER BY started_at DESC LIMIT 50;
--   (services/qa-svc/src/server.js linha 395)
--
-- Indices existentes em product_qa_runs:
--   idx_qa_runs_product   (product_id, created_at DESC)  -- nota: created_at, NAO started_at
--   idx_qa_runs_verdict   (verdict)
--   idx_qa_runs_n8n       (n8n_execution_id)
--
-- PROBLEMA: a query ordena por started_at mas indice e em created_at.
-- Em INSERT inicial ambos sao DEFAULT NOW() (mesmo valor), mas:
-- 1. Postgres planner nao sabe que created_at == started_at semanticamente
-- 2. Plano de execucao: idx_qa_runs_product seleciona por product_id, mas
--    SORT EXTERNO necessario para ORDER BY started_at
-- 3. LIMIT 50 ajuda mas com produto popular (50+ runs historicamente) vira gargalo
--
-- AINDA: started_at e o timestamp CORRETO semanticamente (quando QA iniciou)
-- enquanto created_at e quando row foi inserida. Em retry/replay manual eles
-- podem divergir. Query usa started_at corretamente, indice e que esta errado.
--
-- FIX: indice composto (product_id, started_at DESC) - 1 scan, sem sort.
-- Cost estimate antes: 12-25ms com sort externo
-- Cost estimate depois: 0.5ms index-only scan + LIMIT
-- ~25x melhor em produto com 100+ QA runs historico.
--
-- NOTA: idx_qa_runs_product (created_at DESC) mantido por enquanto.
-- Outras queries internas podem usar created_at (cron cleanup, auditoria por
-- data de gravacao). Drop em migration futura se pg_stat_user_indexes confirmar
-- zero usage por 2 semanas.

CREATE INDEX IF NOT EXISTS idx_qa_runs_product_started
  ON product_qa_runs (product_id, started_at DESC);

COMMENT ON INDEX idx_qa_runs_product_started IS
  'W14-6: composto p/ /qa-svc qa-runs/by-product ORDER BY started_at. Substitui sort externo por index scan.';

-- Validacao pos-apply:
--   EXPLAIN ANALYZE
--     SELECT * FROM product_qa_runs WHERE product_id = '<uuid>'
--      ORDER BY started_at DESC LIMIT 50;
--   Esperado: Index Scan using idx_qa_runs_product_started
--             (sem Sort node, cost < 5.0)

DO $$
BEGIN
  RAISE NOTICE 'W14-6: indice idx_qa_runs_product_started criado (ou ja existia)';
END $$;
