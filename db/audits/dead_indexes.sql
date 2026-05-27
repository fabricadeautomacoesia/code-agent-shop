-- ============================================================
-- AUDIT: Dead Indexes Detection (FIX-WORKER-18 pass 8)
-- ============================================================
-- Identifica indices candidatos a DROP baseado em pg_stat_user_indexes.
-- Pattern industria-standard pos-2-weeks de estatistica colhida.
--
-- IMPORTANTE - LEIA ANTES DE DROP:
--   1. Idx PRIMARY KEY + UNIQUE constraints NUNCA DROP (mesmo se idx_scan=0).
--      Postgres usa para enforce constraints DURANTE INSERT/UPDATE.
--   2. Idx criados recentemente (< 7 dias) podem mostrar 0 scans mas estarao
--      uteis pos warm-up. Filtrar por idx_blks_hit > 0 ajuda.
--   3. Idx parciais (mig 011, 031, 038, 041, 042) podem ter 0 scans nas
--      queries dispoiveis mas serem CRITICOS em queries futuras documentadas.
--   4. SEMPRE testar EXPLAIN ANALYZE da query alvo apos DROP em staging.
--
-- USAGE:
--   psql -f db/audits/dead_indexes.sql
--   OR via /aiops/db/dead-indexes endpoint (admin-only)
-- ============================================================

-- 1. Indices ZERO scans em produção (candidatos primarios DROP)
-- Exclude PK + UNIQUE (constraints usam, mesmo sem scans)
SELECT
  schemaname,
  tablename,
  indexname,
  pg_size_pretty(pg_relation_size(indexrelid)) AS size,
  idx_scan AS scans,
  idx_tup_read AS reads,
  idx_tup_fetch AS fetches,
  CASE
    WHEN idx_scan = 0 THEN 'CANDIDATE_DROP'
    WHEN idx_scan < 50 THEN 'LOW_USAGE'
    ELSE 'ACTIVE'
  END AS recommendation
FROM pg_stat_user_indexes ui
JOIN pg_index i ON i.indexrelid = ui.indexrelid
WHERE NOT i.indisunique          -- exclude UNIQUE constraints
  AND NOT i.indisprimary         -- exclude PRIMARY KEY
  AND schemaname NOT IN ('pg_catalog', 'information_schema')
  -- Excluir idx recentes criados via migrations (heuristica: pg_stat ja
  -- coletou pelo menos 100 INSERTs na tabela)
  AND (
    SELECT n_tup_ins FROM pg_stat_user_tables t
     WHERE t.relid = ui.relid
  ) > 100
ORDER BY idx_scan ASC, pg_relation_size(indexrelid) DESC
LIMIT 50;

-- 2. Indices REDUNDANTES (mesma coluna inicial, idx maior cobre menor)
-- Heuristica: 2 idx no mesmo tablename + mesma 1a coluna -> menor pode ser drop
-- (idx maior cobre queries do menor via index-only scan parcial)
SELECT
  t.relname AS tablename,
  ix1.indexrelid::regclass AS smaller_idx,
  ix2.indexrelid::regclass AS larger_idx,
  pg_size_pretty(pg_relation_size(ix1.indexrelid)) AS smaller_size,
  pg_size_pretty(pg_relation_size(ix2.indexrelid)) AS larger_size,
  'Possivel redundancia (mesma 1a coluna)' AS hint
FROM pg_index ix1
JOIN pg_index ix2 ON ix1.indrelid = ix2.indrelid
  AND ix1.indexrelid < ix2.indexrelid  -- evita duplicacao A-B + B-A
  AND ix1.indkey[0] = ix2.indkey[0]    -- mesma 1a coluna indexada
JOIN pg_class t ON t.oid = ix1.indrelid
WHERE NOT ix1.indisunique AND NOT ix1.indisprimary
  AND NOT ix2.indisunique AND NOT ix2.indisprimary
  AND pg_relation_size(ix1.indexrelid) < pg_relation_size(ix2.indexrelid)
ORDER BY pg_relation_size(ix1.indexrelid) DESC
LIMIT 20;

-- 3. Bloat estimation - idx muito > tabela = candidate REINDEX (nao DROP)
SELECT
  schemaname,
  tablename,
  indexname,
  pg_size_pretty(pg_relation_size(indexrelid)) AS idx_size,
  pg_size_pretty(pg_relation_size(relid)) AS table_size,
  ROUND(100.0 * pg_relation_size(indexrelid) / NULLIF(pg_relation_size(relid), 0), 1) AS pct_of_table,
  CASE
    WHEN pg_relation_size(indexrelid) > pg_relation_size(relid) THEN 'REINDEX_RECOMMENDED'
    WHEN pg_relation_size(indexrelid) > pg_relation_size(relid) * 0.5 THEN 'INSPECT'
    ELSE 'OK'
  END AS bloat_status
FROM pg_stat_user_indexes
WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
  AND pg_relation_size(indexrelid) > 1048576  -- > 1MB
ORDER BY pg_relation_size(indexrelid) DESC
LIMIT 30;

-- 4. Top 10 indices mais USADOS (sanity check - confirmar idx criticos ativos)
SELECT
  schemaname,
  tablename,
  indexname,
  idx_scan AS scans,
  pg_size_pretty(pg_relation_size(indexrelid)) AS size,
  idx_tup_read AS reads
FROM pg_stat_user_indexes
WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
ORDER BY idx_scan DESC
LIMIT 10;
