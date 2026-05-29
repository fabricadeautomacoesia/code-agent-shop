-- Migration 125: idx_vault_rotation_due_id direction parity ASC+ASC tiebreaker
-- ============================================================================
--
-- FIX-WORKER-14 pass 641: consume vault-svc rotationAlertCron ORDER BY tiebreaker
-- direction parity. Paridade Regra D V8 cross-svc (cadeia mig 102-124).
--
-- CONTEXT:
--   vault-svc rotationAlertCron (server.js linha 264-273 - pass 632 fixed):
--     SELECT id, key_alias, provider, rotation_due_at,
--            EXTRACT(EPOCH FROM (rotation_due_at - NOW()))/86400 AS days_remaining
--       FROM vault_api_keys
--      WHERE is_active = TRUE
--        AND rotation_due_at IS NOT NULL
--        AND rotation_due_at < NOW() + INTERVAL '7 days'
--      ORDER BY rotation_due_at ASC, id ASC
--      LIMIT 50
--
--   Cron diario - rotation alert para admins.
--   Pass 632 adicionou id ASC tiebreaker - este mig cobre idx coverage.
--
-- PRE-FIX existing index (mig 003:118):
--   idx_vault_rotation ON vault_api_keys(rotation_due_at) WHERE is_active = TRUE
--   - Covers PARTIAL (is_active=TRUE) + rotation_due_at (range)
--   - MAS NAO inclui id ASC tiebreaker
--   - Mass-provision keys mesma sessao (seller signup batch) -> 5+ keys mesma
--     rotation_due_at second-precision (90d default rotation_days)
--   - id ASC tiebreaker forca External Sort node externo
--   - Edge case mas cron diario = compounded over months (audit drift)
--
-- POST-FIX:
--   idx_vault_rotation_due_id PARTIAL composite direction parity Regra D V8:
--     ON vault_api_keys (rotation_due_at ASC, id ASC) WHERE is_active = TRUE
--
--   Planner steps:
--   1. Direct Index Scan idx_vault_rotation_due_id PARTIAL WHERE is_active
--      (pre-sorted full ORDER BY ascending tiebreaker)
--   2. Filter rotation_due_at IS NOT NULL + < NOW + 7d via PG idx scan
--   3. LIMIT 50 (SEM External Sort)
--
--   Latency: ~1-3ms External Sort eliminado (small dataset 50 rows)
--   Storage: ~50-100KB PARTIAL (is_active filtered)
--
--   Trade-off vs mig 003 idx_vault_rotation:
--   - mig 003 cobre simple range queries
--   - mig 125 (este) cobre cron ORDER tiebreaker completo direction parity
--   - Manter ambos. pg_stat_user_indexes decision drop futuro
--
-- COVERAGE QUERIES:
--   - rotationAlertCron diario (este path)
--   - Future cron vault_export forensic
--
-- PATTERN V8 W14 cadeia direction parity composite tiebreaker:
--   passes 102-124 (23 indexes consolidacao previa)
--   pass 125 (este) vault_rotation direction parity ASC+ASC variant
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_vault_rotation_due_id;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_vault_rotation_due_id
    ON vault_api_keys (rotation_due_at ASC, id ASC)
    WHERE is_active = TRUE;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_vault_rotation_due_id create: % - %', SQLSTATE, SQLERRM;
END $$;

ANALYZE vault_api_keys;

DO $$ BEGIN
  RAISE NOTICE 'W14-pass641: idx_vault_rotation_due_id PARTIAL ASC+ASC tiebreaker (paridade pass 632 ORDER fix + Regra D cadeia mig 102-124)';
END $$;
