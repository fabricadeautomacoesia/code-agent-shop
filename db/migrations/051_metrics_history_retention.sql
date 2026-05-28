-- Migration 051: metrics_history retention policy + index BRIN
--
-- Análise W18 pass 126:
-- - metrics_history: 11958 rows / 1.3 dias / 3.1 MB
-- - heap_blks_hit 84.9% (BAIXO - threshold 95% para PG prod)
-- - Inserts: ~6000/dia (aiops worker coleta a cada ~15s)
-- - Sem retention -> crescimento linear -> ~180k rows/mes -> futuro problem
--
-- Estrategia:
-- 1. BRIN index em collected_at (time-series ideal): muito menor que btree
--    (BRIN ~10kB vs btree ~488kB), perfeito p/ INSERT-heavy + range queries.
-- 2. Retention via DELETE >30d em cron (executado pelo aiops worker)
--    sera adicionado em codigo, esta migration apenas adiciona idx p/ acelerar.
-- 3. NAO dropamos idx_metrics_collected (btree) imediatamente - manter ate
--    proximo pass auditar uso real apos BRIN active.
--
-- BRIN vantagens p/ time-series:
-- - 50-100x menor que btree (storage)
-- - Range queries (WHERE collected_at > NOW() - INTERVAL 1h) sao optimal
-- - Lookups exatos sao mais lentos, mas worker nunca faz exact match
-- - INSERT mais rapido (menos pages a atualizar)
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_metrics_collected_brin;

CREATE INDEX IF NOT EXISTS idx_metrics_collected_brin
  ON metrics_history USING BRIN (collected_at)
  WITH (pages_per_range = 32);

-- ANALYZE pra refresh statistics + planner usar novo idx
ANALYZE metrics_history;
