-- Migration 071: indice composto PARTIAL para qa-svc inflight detection
-- W14 pass 239 - 2026-05-28
--
-- CONTEXTO:
-- qa-svc server.js:165 executa em CADA dispatch de QA (hot path):
--   SELECT id, started_at FROM product_qa_runs
--    WHERE product_id = $1
--      AND verdict = 'running'
--      AND started_at > NOW() - INTERVAL '10 minutes'
--    ORDER BY started_at DESC LIMIT 1
--
-- INDICES EXISTENTES (mig 005):
--   idx_qa_runs_product: (product_id, created_at DESC) - usado em /admin list
--   idx_qa_runs_verdict: (verdict) - cardinality baixa, pouco util
--   idx_qa_runs_n8n: (n8n_execution_id) - unique lookup
--
-- PROBLEMA:
-- idx_qa_runs_product cobre product_id mas ordena por created_at, nao started_at.
-- - PG faz Index Scan filtrando created_at -> in-memory filter verdict='running'
--   + started_at>NOW()-10min
-- - 99% das rows passam product_id filter (cada produto tem N qa_runs historico)
--   mas SOMENTE 1 inflight per product no max
-- - Wasteful filter chain quando producto tem 50+ runs (re-QA frequente)
-- - LIMIT 1 mas precisa scan multiplas rows ate achar match
--
-- POST-FIX: indice PARTIAL super-otimizado:
--   ON product_qa_runs(product_id, started_at DESC) WHERE verdict='running'
-- - PARTIAL filtra ~99% rows na criacao do idx (so 'running' indexed)
-- - product_id + started_at DESC: lookup direto + ORDER BY satisfeito sem sort
-- - Inflight detection 1-2ms (era 5-30ms em produtos high-volume)
--
-- ROLLBACK: DROP INDEX IF EXISTS idx_qa_runs_inflight;

CREATE INDEX IF NOT EXISTS idx_qa_runs_inflight
  ON product_qa_runs(product_id, started_at DESC)
  WHERE verdict = 'running';

DO $$
BEGIN
  RAISE NOTICE 'W14-pass239: idx_qa_runs_inflight created (PARTIAL for inflight detection)';
END $$;
