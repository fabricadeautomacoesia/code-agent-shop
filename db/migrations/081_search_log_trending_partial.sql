-- Migration 081: idx PARTIAL search_log para /trending hot-path
-- W18 pass 283 - 2026-05-28
--
-- CONTEXTO:
-- /api/search/trending faz query agregada:
--   WHERE created_at > NOW() - INTERVAL '7 days'
--     AND query_normalized != ''
--     AND CHAR_LENGTH(query_normalized) >= 3
--     AND query_normalized !~ '[''"<>;\\]'
--     AND query_normalized NOT ILIKE '%--%'
--     AND query_normalized NOT ILIKE '%/*%'
--   GROUP BY query_normalized
--   HAVING COUNT(*) >= 2
--   ORDER BY count DESC, query_normalized ASC
--
-- idx_search_log_recent (created_at DESC, query_normalized) cobre WHERE+ORDER mas
-- nao filtra rows ruidosas em DB sem trigger pass 027 ou rows pre-trigger.
--
-- HOT-PATH: trending eh chamado em homepage banner trending searches + autocomplete
-- footer + admin dashboard. Cache 300s ja existente, mas miss + rebuild custa em DB
-- com 1M+ search_log rows.
--
-- POST-FIX: idx PARTIAL com predicate static (nao usa NOW() - PG aceita imutaveis):
--   ON search_log (created_at DESC, query_normalized)
--   WHERE query_normalized IS NOT NULL
--     AND query_normalized != ''
--     AND CHAR_LENGTH(query_normalized) >= 3
-- (regexes/ILIKE NAO podem ser parcial predicate em PG - apenas exprs IMMUTABLE.
--  Mas o predicado static acima ja elimina maioria do noise pre-trigger 027.)
--
-- Cobertura combinada: idx PARTIAL +short-circuit static + idx_search_log_recent
-- p/ created_at range scan secundario.
--
-- ROLLBACK: DROP INDEX IF EXISTS idx_search_log_trending_clean;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_search_log_trending_clean
    ON search_log (created_at DESC, query_normalized)
    WHERE query_normalized IS NOT NULL
      AND query_normalized != ''
      AND CHAR_LENGTH(query_normalized) >= 3;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

ANALYZE search_log;

DO $$
BEGIN
  RAISE NOTICE 'W18-pass283: idx_search_log_trending_clean created (PARTIAL clean queries)';
END $$;
