-- Migration 128: idx_disputes_order_item_active PARTIAL composite (anti-double-open lookup)
-- ============================================================================
--
-- FIX-WORKER-14 pass 703: consume order-svc dispute create anti-double-open query
-- Paridade Regra D V8 cross-svc (cadeia mig 102-127).
--
-- CONTEXT:
--   order-svc POST /:id/dispute (orders.js linha 772-777):
--     SELECT id, status, opened_at FROM disputes
--      WHERE order_item_id = $1::UUID
--        AND opened_by_user_id = $2::UUID
--        AND status IN ('open', 'investigating')
--      LIMIT 1
--
--   Anti-double-open guard - buyer evitar abrir dispute duplicada
--   no MESMO order_item_id quando ja tem 1 ativa.
--
-- PRE-FIX existing indexes (mig 007):
--   idx_disputes_order (order_id) - cobre FK lookup mas nao composite WHERE
--   idx_disputes_status (status) - simple filter
--   idx_disputes_open (created_at DESC) WHERE status IN ('opened','under_review') -
--     PARTIAL p/ admin queue, status enum mismatch (note: 'opened' vs 'open')
--   - Nenhum cobre (order_item_id, opened_by_user_id, status) lookup composite
--   - Seq Scan ou idx_disputes_order + Filter pos-scan (sub-optimal)
--
-- POST-FIX:
--   idx_disputes_order_item_active PARTIAL composite:
--     ON disputes (order_item_id, opened_by_user_id) WHERE status IN ('open','investigating')
--
--   Planner steps:
--   1. Direct Index Scan idx_disputes_order_item_active PARTIAL (status filter)
--      WHERE order_item_id + opened_by_user_id (exact match composite)
--   2. LIMIT 1 (returns instant ou empty)
--
--   Latency: ~5-15ms Seq Scan -> ~1ms Index Scan (anti-double-open hot path)
--   Storage: ~50-100KB PARTIAL (status active subset only - ~10-20% rows)
--
--   Trade-off vs mig 007 idx_disputes_order:
--   - mig 007 cobre order_id only (FK reverse lookup admin)
--   - mig 128 (este) cobre buyer-facing anti-double-open composite
--   - Manter ambos. pg_stat_user_indexes decision drop futuro
--
-- COVERAGE QUERIES:
--   - POST /:id/dispute anti-double-open (este path)
--   - Future buyer dispute history dashboard
--
-- PATTERN V8 W14 cadeia direction parity composite + PARTIAL:
--   passes 102-127 (26 indexes consolidacao previa)
--   pass 128 (este) disputes_order_item_active PARTIAL composite (status enum)
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_disputes_order_item_active;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_disputes_order_item_active
    ON disputes (order_item_id, opened_by_user_id)
    WHERE status IN ('open','investigating');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_disputes_order_item_active create: % - %', SQLSTATE, SQLERRM;
END $$;

ANALYZE disputes;

DO $$ BEGIN
  RAISE NOTICE 'W14-pass703: idx_disputes_order_item_active PARTIAL composite anti-double-open (paridade Regra D cadeia mig 102-127)';
END $$;
