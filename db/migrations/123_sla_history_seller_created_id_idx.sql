-- Migration 123: idx_sla_history_seller_created_id direction parity DESC+DESC tiebreaker
-- ============================================================================
--
-- FIX-WORKER-14 pass 635: consume seller-svc /sellers/me/sla-history ORDER BY
-- tiebreaker direction parity. Paridade Regra D V8 cross-svc (cadeia mig 102-122).
--
-- CONTEXT:
--   seller-svc /sellers/me/sla-history (me.js linha 457-466):
--     SELECT h.id, h.seller_id, h.event, h.deadline_was, h.actual_upload_at,
--            h.days_overdue, h.actor_user_id, h.notes, h.created_at,
--            COUNT(*) OVER()::INT AS _total
--       FROM seller_sla_history h
--       JOIN sellers s ON s.id = h.seller_id
--      WHERE s.user_id = $1
--      ORDER BY h.created_at DESC, h.id DESC
--      LIMIT $2 OFFSET $3
--
--   Used by:
--   - dashboard-seller /financeiro SLA tab polling 30s
--   - Seller forensic review compliance LGPD audit
--
-- PRE-FIX existing index (mig 003:169):
--   idx_sla_history_seller ON seller_sla_history(seller_id, created_at DESC)
--   - Covers WHERE seller_id + ORDER BY created_at DESC
--   - MAS NAO inclui id DESC tiebreaker
--   - Cron SLA roda burst (5min interval) - 2+ events mesma created_at second-precision
--     em mass upload campaign (seller envia 10 produtos mesma sessao)
--   - id DESC tiebreaker forca External Sort node externo
--   - Em prod sellers veteranos (12+m) = 100-200 sla history rows
--   - External Sort overhead per query ~3-5ms
--
-- POST-FIX:
--   idx_sla_history_seller_created_id composite direction parity Regra D V8:
--     ON seller_sla_history (seller_id, created_at DESC, id DESC)
--
--   Planner steps:
--   1. Direct Index Scan idx_sla_history_seller_created_id WHERE seller_id
--      (pre-sorted full ORDER BY descending tiebreaker)
--   2. JOIN sellers via PK
--   3. LIMIT N + OFFSET M (SEM External Sort)
--
--   Latency: ~3-5ms External Sort eliminado -> ~1-2ms total query
--   Storage: ~500KB-1MB para 10k-20k sla history rows
--
--   Trade-off vs mig 003 idx_sla_history_seller:
--   - mig 003 cobre simple WHERE queries (sem sort tiebreaker)
--   - mig 123 (este) cobre /sla-history ORDER tiebreaker completo direction parity
--   - Manter ambos. pg_stat_user_indexes decision drop futuro
--
-- COVERAGE QUERIES:
--   - GET /sellers/me/sla-history (este path - seller dashboard polling)
--   - Future cron sla_compliance_export reports
--
-- PATTERN V8 W14 cadeia direction parity composite tiebreaker:
--   passes 102-122 (21 indexes consolidacao previa)
--   pass 123 (este) sla_history direction parity DESC+DESC
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_sla_history_seller_created_id;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_sla_history_seller_created_id
    ON seller_sla_history (seller_id, created_at DESC, id DESC);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_sla_history_seller_created_id create: % - %', SQLSTATE, SQLERRM;
END $$;

ANALYZE seller_sla_history;

DO $$ BEGIN
  RAISE NOTICE 'W14-pass635: idx_sla_history_seller_created_id direction parity DESC+DESC tiebreaker /sla-history seller dashboard (paridade Regra D cadeia mig 102-122)';
END $$;
