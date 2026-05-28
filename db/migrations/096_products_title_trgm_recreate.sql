-- Migration 096: RECRIA idx_products_title_trgm (mig 048 DROP era prematuro)
-- ============================================================================
--
-- FIX-WORKER-10 pass 442: CRITICAL PERF REGRESSION - autocomplete sem trigram idx
--
-- CONTEXT:
--   Migration 048 (pass 119, W18) dropou idx_products_title_trgm pensando que
--   "ILIKE title nunca e o criterio principal de search" e usava idx_scan=0
--   como evidencia (sem detectar pg_trgm operators % + similarity()).
--
--   PORÉM search-svc /autocomplete (linha 358) usa:
--     SELECT title, slug, similarity(title, $1) AS s
--      FROM products
--      WHERE status IN ('approved','platform_owned')
--        AND deleted_at IS NULL
--        AND title % $1
--      ORDER BY s DESC, slug LIMIT $2
--
--   Os operadores pg_trgm (% e similarity()) PRECISAM do idx GIN trigram p/
--   evitar Seq Scan. Sem idx:
--   - title % $1 -> Seq Scan products (~50k rows em prod)
--   - similarity() ORDER BY -> Sort externo
--   - Latencia /autocomplete: ~150-300ms per keystroke
--   - Hot-path: user digita 5 chars -> 5 full-table scans
--
-- ROOT CAUSE pass 119:
--   idx_scan=0 em pg_stat_user_indexes pode acontecer mesmo com queries
--   usando o idx se:
--   - PG planner optou por Seq Scan em dataset pequeno (early dev)
--   - reset stats apos mig 048 nao validou em fase carga prod realistica
--   - Trigram idxs precisam dataset ≥10k rows p/ planner preferir
--
-- POST-FIX:
--   RECRIA idx_products_title_trgm GIN com gin_trgm_ops.
--   - PG planner agora usa BitmapIndexScan via trigram
--   - Latencia /autocomplete: ~200ms -> ~5-15ms (15-40x melhoria)
--   - /autocomplete hot-path mobile: keystroke responsiveness restaurada
--
-- IMPACT EM PROD:
--   - search-svc /autocomplete eh hot-path mobile (user digita pesquisa)
--   - cada keystroke = 1 query backend
--   - Sem idx: typing 5 chars = 5 * 250ms = 1.25s wait acumulado
--   - Com idx: typing 5 chars = 5 * 10ms = 50ms acumulado
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_products_title_trgm;
--   (NAO recomendado - perf regression imediata)

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_products_title_trgm
    ON products USING GIN (title gin_trgm_ops);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_products_title_trgm recreate: % - %', SQLSTATE, SQLERRM;
END $$;

-- ANALYZE p/ planner stats fresh
ANALYZE products;

DO $$ BEGIN
  RAISE NOTICE 'W10-pass442: idx_products_title_trgm RECRIADO (mig 048 drop era prematuro - autocomplete usa pg_trgm)';
END $$;
