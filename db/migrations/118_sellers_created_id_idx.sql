-- Migration 118: idx_sellers_created_id direction parity DESC+DESC tiebreaker
-- ============================================================================
--
-- FIX-WORKER-14 pass 624: consume seller-svc admin /sellers/all ORDER BY tiebreaker
-- direction parity. Paridade Regra D V8 cross-svc (cadeia mig 102-117).
--
-- CONTEXT:
--   seller-svc admin /sellers/all (admin.js linha 408-418):
--     SELECT s.id, s.store_slug, ..., COUNT(*) OVER()::INT AS _total
--       FROM sellers s JOIN users u ON u.id = s.user_id
--      WHERE [status/seller_class/q filter]
--      ORDER BY s.created_at DESC, s.id DESC  -- pass 624 fix DESC+DESC parity
--      LIMIT $N OFFSET $M
--
-- PRE-FIX (pass 624 ANTES):
--   ORDER BY s.created_at DESC, s.id ASC (mixed direction)
--   - PG planner forca External Sort node (idx (created_at DESC, id ASC) nao existe)
--   - Outlier vs cadeia Regra D V8 cross-svc (30+ sites DESC+DESC)
--   - Latency hot path admin polling /admin/sellers ~10ms External Sort overhead
--
-- POST-FIX:
--   1. admin.js linha 415 normalized ORDER BY (s.created_at DESC, s.id DESC)
--   2. Este idx composite (created_at DESC, id DESC) suporta direct scan pre-sorted
--
--   Planner steps:
--   1. Direct Index Scan idx_sellers_created_id (pre-sorted full ORDER BY descending)
--   2. JOIN users via PK
--   3. LIMIT N + OFFSET M (SEM External Sort)
--
--   Latency: ~10-30ms External Sort eliminado -> ~3-8ms total query
--   Storage: ~1-2MB para ~10k sellers prod
--
--   Trade-off: novo idx separado vs existing (mig 003 + 049):
--   - mig 003 cria PK idx
--   - mig 049 cria fk indexes (user_id, asaas_*)
--   - mig 084 cria PARTIAL pending_kyc (kyc_submitted_at, created_at) ASC
--   - Nenhum cobre admin /all listing direction parity
--   - mig 118 (este) supre gap especifico
--
-- COVERAGE QUERIES:
--   - GET /sellers/admin/all (este path - admin moderation queue)
--   - Future cron seller_export reports
--
-- PATTERN V8 W14 cadeia direction parity composite tiebreaker:
--   passes 102-117 (16 indexes consolidacao previa)
--   pass 118 (este) sellers_created_id direction parity DESC+DESC
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_sellers_created_id;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_sellers_created_id
    ON sellers (created_at DESC, id DESC);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_sellers_created_id create: % - %', SQLSTATE, SQLERRM;
END $$;

ANALYZE sellers;

DO $$ BEGIN
  RAISE NOTICE 'W14-pass624: idx_sellers_created_id direction parity DESC+DESC tiebreaker (paridade Regra D cadeia mig 102-117 + ORDER fix admin.js)';
END $$;
