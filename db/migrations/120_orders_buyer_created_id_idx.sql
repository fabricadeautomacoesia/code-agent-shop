-- Migration 120: idx_orders_buyer_created_id direction parity DESC+DESC tiebreaker
-- ============================================================================
--
-- FIX-WORKER-14 pass 626: consume order-svc GET /orders (buyer listing /conta/pedidos)
-- ORDER BY tiebreaker direction parity. Paridade Regra D V8 cross-svc (cadeia
-- mig 102-119).
--
-- CONTEXT:
--   order-svc GET / buyer orders (orders.js linha 486-506):
--     SELECT o.id, o.order_number, o.status, o.payment_status, ...
--            COALESCE(items.preview, '[]'::JSON) AS items_preview,
--            COUNT(*) OVER()::INT AS _total
--       FROM orders o
--       LEFT JOIN LATERAL ( ... ) items ON TRUE
--      WHERE o.buyer_user_id = $1 [AND o.status = $2]
--      ORDER BY o.created_at DESC, o.id DESC
--      LIMIT $N OFFSET $M
--
--   Hot path /conta/pedidos page polling - HOT user-facing endpoint.
--   Every authenticated user lands here pos-checkout. Multiple polls.
--
-- PRE-FIX existing index (mig 006):
--   idx_orders_buyer ON orders(buyer_user_id, created_at DESC)
--   - Covers WHERE buyer_user_id + ORDER BY created_at DESC (range scan)
--   - MAS NAO inclui id tiebreaker DESC
--   - Power-buyers (50+ orders), mass-checkout cron mesma instant:
--     created_at second-precision IDENTICO entre orders -> tiebreaker
--     id DESC forca External Sort node externo
--   - LATERAL JOIN items_preview ja eh hot - External Sort overhead ainda
--     mais perceptivel (multiple JOIN layers)
--   - Em prod com 10k+ orders cumulative = significant overhead
--
-- POST-FIX:
--   idx_orders_buyer_created_id composite direction parity Regra D V8:
--     ON orders (buyer_user_id, created_at DESC, id DESC)
--
--   Planner steps:
--   1. Direct Index Scan idx_orders_buyer_created_id WHERE buyer_user_id
--      (pre-sorted full ORDER BY descending tiebreaker)
--   2. LATERAL JOIN items via order_id idx
--   3. LIMIT N + OFFSET M (SEM External Sort)
--
--   Latency: ~5-15ms External Sort eliminado -> ~2-5ms total query
--   Storage: ~3-5MB para 10k orders (acceptable)
--
--   Trade-off vs mig 006 idx_orders_buyer:
--   - mig 006 cobre simple WHERE queries (sem sort tiebreaker)
--   - mig 120 (este) cobre /conta/pedidos ORDER tiebreaker completo
--   - Manter ambos. pg_stat_user_indexes decision drop futuro
--
-- COVERAGE QUERIES:
--   - GET /orders (este path - /conta/pedidos user page polling)
--   - Future cron buyer_export reports
--
-- PATTERN V8 W14 cadeia direction parity composite tiebreaker:
--   passes 102-119 (18 indexes consolidacao previa)
--   pass 120 (este) orders_buyer direction parity DESC+DESC
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_orders_buyer_created_id;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_orders_buyer_created_id
    ON orders (buyer_user_id, created_at DESC, id DESC);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_orders_buyer_created_id create: % - %', SQLSTATE, SQLERRM;
END $$;

ANALYZE orders;

DO $$ BEGIN
  RAISE NOTICE 'W14-pass626: idx_orders_buyer_created_id direction parity DESC+DESC tiebreaker /conta/pedidos hot path (paridade Regra D cadeia mig 102-119)';
END $$;
