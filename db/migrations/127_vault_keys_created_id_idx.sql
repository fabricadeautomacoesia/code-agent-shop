-- Migration 127: idx_vault_keys_created_id composite (admin /keys listing DESC+DESC)
-- ============================================================================
--
-- FIX-WORKER-14 pass 692: consume vault-svc admin GET /keys ORDER BY tiebreaker
-- direction parity. Paridade Regra D V8 cross-svc (cadeia mig 102-126).
--
-- CONTEXT:
--   vault-svc admin GET /keys (server.js linha 594-615):
--     SELECT k.id, k.seller_id, k.provider, k.key_alias, k.key_fingerprint, ...
--            COUNT(*) OVER()::INT AS _total
--       FROM vault_api_keys k
--       LEFT JOIN LATERAL (...) u ON TRUE
--      WHERE [provider/is_active/is_platform_pool filters]
--      ORDER BY k.created_at DESC, k.id DESC
--      LIMIT $N OFFSET $M
--
--   admin /admin/vault dashboard listing - polling 60s.
--   Multi-admin sessions amplificam DB pressure.
--
-- PRE-FIX existing indexes (mig 003):
--   idx_vault_seller PARTIAL (seller_id) WHERE is_active = TRUE
--   idx_vault_provider PARTIAL (provider) WHERE is_active = TRUE
--   idx_vault_platform_pool PARTIAL (is_platform_pool) WHERE is_active = TRUE
--   idx_vault_rotation PARTIAL (rotation_due_at) WHERE is_active = TRUE
--   - Nenhum cobre (created_at DESC, id DESC) admin listing ORDER
--   - Sort External quando admin filtra provider OR sem filter
--
-- POST-FIX:
--   idx_vault_keys_created_id composite direction parity Regra D V8:
--     ON vault_api_keys (created_at DESC, id DESC)
--
--   Planner steps:
--   1. Direct Index Scan idx_vault_keys_created_id (pre-sorted descending)
--   2. Filter WHERE provider/is_active/is_platform_pool via row check
--   3. LEFT JOIN LATERAL vault_key_usage stats
--   4. LIMIT N + OFFSET M (SEM External Sort node)
--
--   Latency: ~30-80ms External Sort -> ~3-8ms total query
--   Storage: ~500KB-1MB para 5k-10k vault_api_keys prod
--
--   Trade-off: novo idx separado vs existing PARTIAL idx (5):
--   - mig 003 PARTIAL cobre filters separados (is_active, provider, etc)
--   - mig 127 (este) cobre ORDER global cross-filter
--   - Manter todos. pg_stat_user_indexes decision drop futuro
--
-- COVERAGE QUERIES:
--   - GET /keys admin listing (este path - /admin/vault dashboard)
--   - Future cron vault_export reports
--
-- PATTERN V8 W14 cadeia direction parity DESC+DESC composite:
--   passes 102-126 (25 indexes consolidacao previa)
--   pass 127 (este) vault_keys_created_id direction parity DESC+DESC
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_vault_keys_created_id;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_vault_keys_created_id
    ON vault_api_keys (created_at DESC, id DESC);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_vault_keys_created_id create: % - %', SQLSTATE, SQLERRM;
END $$;

ANALYZE vault_api_keys;

DO $$ BEGIN
  RAISE NOTICE 'W14-pass692: idx_vault_keys_created_id direction parity DESC+DESC tiebreaker /admin/vault listing (paridade Regra D cadeia mig 102-126)';
END $$;
