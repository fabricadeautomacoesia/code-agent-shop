-- ============================================================
-- Migration 041: product_views rolling 90d partial index
-- FIX-WORKER-18 pass 7: idx parcial WHERE created_at > <data_fixa>
-- Resolve gap doc W18 pass 6 (mig 038:52-58):
--   "PG REQUER imutabilidade no WHERE de CREATE INDEX. NOW() nao IMMUTABLE.
--    Solucao requer cron periodico DROP + CREATE com data dinamica"
-- ============================================================
-- CONTEXTO:
--   product-svc/routes/public.js /recommendations/for-me:
--     CTE user_categories: AND v.created_at > NOW() - INTERVAL '30 days'
--     CTE viewed: AND created_at > NOW() - INTERVAL '90 days'
--
--   Plano sem idx parcial:
--   - idx_pviews_user_recent (user_id, created_at DESC) - mig 011:13
--   - Scan user_id ok, mas filtra created_at apos fetch -> N rows desperdicados
--   - product_views eh tabela ALTA escrita (1 row/page view ~~1M+ rows mensais)
--   - 90% das rows sao > 90d (irrelevantes p/ recommendations)
--
--   Plano com idx parcial:
--   - WHERE created_at > '2026-02-26' (data fixa hardcoded)
--   - Idx contem SO ~10% das rows (rolling window 90d)
--   - Index-only scan (user_id + created_at no leaf)
--   - Rebuild semanal via cron mantem janela atualizada
--
-- ============================================================

-- 1. IDX PARCIAL com DATA FIXA (rebuild via cron job semanal)
-- Data inicial: 2026-02-26 = 2026-05-27 (today) - 90 days
-- Cron job atualiza semanalmente (DROP + CREATE com data NOW-90d)
CREATE INDEX IF NOT EXISTS idx_pviews_rolling_90d
  ON product_views(user_id, created_at DESC)
  WHERE user_id IS NOT NULL
    AND created_at > '2026-02-26'::TIMESTAMPTZ;

COMMENT ON INDEX idx_pviews_rolling_90d IS
  'FIX-W18-7: rolling 90d window. Data limite fixa - cron node-cron semanal DROP+CREATE atualiza. Cobre /recommendations/for-me CTE viewed + user_categories.';

-- 2. IDX PARCIAL 30d (mais agressivo p/ CTE user_categories)
-- Janela menor = idx menor + queries 30d MUITO mais rapidas
-- Cron rotaciona junto com 90d (mesma data base, INTERVAL diferente)
CREATE INDEX IF NOT EXISTS idx_pviews_rolling_30d
  ON product_views(user_id, product_id, created_at DESC)
  WHERE user_id IS NOT NULL
    AND created_at > '2026-04-27'::TIMESTAMPTZ;

COMMENT ON INDEX idx_pviews_rolling_30d IS
  'FIX-W18-7: rolling 30d window p/ CTE user_categories (GROUP BY category mais hot). Cron semanal rotaciona junto com idx 90d.';

-- ============================================================
-- CRON ROTATION STRATEGY (implementado em product-svc/src/server.js):
--
-- node-cron @weekly (domingo 03:00 BRT):
--   1. SELECT data atual - 90d -> '<new_90d_date>'
--   2. DROP INDEX CONCURRENTLY IF EXISTS idx_pviews_rolling_90d_new
--   3. CREATE INDEX CONCURRENTLY idx_pviews_rolling_90d_new
--      ON product_views(user_id, created_at DESC)
--      WHERE user_id IS NOT NULL
--        AND created_at > '<new_90d_date>'::TIMESTAMPTZ
--   4. BEGIN; DROP idx_pviews_rolling_90d; ALTER INDEX _new RENAME TO _90d; COMMIT;
--   5. Same para 30d com '<new_30d_date>'
--
-- TRADE-OFFS:
-- - CONCURRENTLY: sem lock table (escrita continua durante rebuild)
-- - Window slack: ate 7 dias mais antigo na pior das hipoteses
-- - Query WHERE created_at > NOW() - 90d ainda funciona (idx parcial =
--   superset; PG planner pode usar Index Scan + filter ou Seq Scan
--   se data muito antiga - idx cobre proximas 90d com slack 7d)
-- ============================================================
