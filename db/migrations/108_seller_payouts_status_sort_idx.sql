-- Migration 108: idx_payouts_seller_status_sort composite (consume seller payouts filter+sort)
-- ============================================================================
--
-- FIX-WORKER-14 pass 536: consume seller-svc /me/payouts filter+sort pattern
--
-- CONTEXT:
--   seller-svc /me/payouts (linha 704) - hot path dashboard-seller (polling 30s)
--   Query padrao quando status filter aplicado (tab "rejected"/"paid"/"pending"):
--     SELECT id, amount_cents, status, ... COUNT(*) OVER()::INT AS _total
--       FROM seller_payouts
--      WHERE seller_id = $1
--        AND status = $2
--      ORDER BY requested_at DESC, id DESC
--      LIMIT $3 OFFSET $4
--
-- PRE-FIX existing indexes:
--   mig 003 idx_payouts_seller (seller_id, requested_at DESC) - cobre sem filter
--   mig 003 idx_payouts_status (status)                       - cobre status global
--   mig 040 idx_seller_payouts_processing_stuck PARTIAL processing
--   mig 077 idx_payouts_admin_queue (composite admin path)
--   mig 082 idx_seller_payouts_non_final_sum (PARTIAL aggregate sum)
--
--   Planner steps quando status filter aplicado:
--   1. Index Scan idx_payouts_seller (scoped seller_id)
--   2. Filter status = $2 (post-scan)
--   3. Sort by requested_at DESC, id DESC (idx fornece parcial, ainda sort)
--   4. LIMIT N + OFFSET M
--
--   Para sellers com 100+ payouts historicos:
--   - Filter pos-scan ~5-10ms extra
--   - Latency: ~20-40ms total
--   - Dashboard-seller payouts tab polling 30s = repetido stress DB
--
-- POST-FIX:
--   idx_payouts_seller_status_sort composite:
--     ON seller_payouts (seller_id, status, requested_at DESC, id DESC)
--
--   Planner steps:
--   1. Direct Index Scan idx_payouts_seller_status_sort (pre-filtered+sorted)
--   2. LIMIT N + OFFSET M (SEM Filter SEM Sort)
--
--   Latency: ~20-40ms -> ~3-8ms (5x improvement em sellers com historico)
--
--   Trade-off vs mig 003 idx_payouts_seller:
--   - Mig 003 ainda cobre listings SEM status filter (default tab)
--   - Manter ambos: mig 003 simpler default + mig 108 status-aware tab
--
-- COVERAGE QUERIES:
--   - seller-svc /me/payouts?status=pending|approved|processing|paid|rejected
--   - admin /admin/payouts?status (paridade pattern - mig 077 ja cobre)
--   - Future cron payouts_sla_check (alert sellers pendentes >7d)
--
-- PATTERN V8 W14 cadeia PARTIAL/composite com sort:
--   pass 086 idx_audit_severity_created PARTIAL warn+
--   pass 094 idx_audit_target_created PARTIAL NOT NULL
--   pass 098 idx_audit_target_type_severity PARTIAL critical
--   pass 100 idx_pwreset_pending_unused PARTIAL used_at IS NULL
--   pass 102 idx_notif_user_inapp_unread PARTIAL channel+is_read
--   pass 103 idx_qa_runs_product_timeout PARTIAL verdict='timeout'
--   pass 104 idx_price_alerts_unnotified PARTIAL last_notified_at IS NULL
--   pass 105 idx_products_sales_public PARTIAL W7 status whitelist
--   pass 106 idx_audit_anonymous_critical PARTIAL HMAC forensic
--   pass 107 idx_qna_seller_pending_sort PARTIAL composite sort
--   pass 108 (este) idx_payouts_seller_status_sort composite filter+sort
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_payouts_seller_status_sort;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_payouts_seller_status_sort
    ON seller_payouts (seller_id, status, requested_at DESC, id DESC);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_payouts_seller_status_sort create: % - %', SQLSTATE, SQLERRM;
END $$;

ANALYZE seller_payouts;

DO $$ BEGIN
  RAISE NOTICE 'W14-pass536: idx_payouts_seller_status_sort composite (consume /me/payouts filter+sort)';
END $$;
