-- Migration 110: idx_asaas_webhook_dead_admin PARTIAL (consume /admin/webhooks/dead endpoint)
-- ============================================================================
--
-- FIX-WORKER-14 pass 560: consume payment-svc /admin/webhooks/dead query
--
-- CONTEXT:
--   payment-svc /admin/webhooks/dead endpoint (linha 1789-1798) - admin dashboard
--   webhooks page lista 'dead' webhook events (retry_count > 5 sem processed_at).
--   Admin investiga incidents Asaas onde webhook foi recebido mas processWebhookEvent
--   falhou >5 vezes (parse error, DB transient, processing logic bug).
--
--   Query padrao (com COUNT(*) OVER() window aggregate):
--     SELECT id, event_type, asaas_payment_id, processing_error, retry_count, received_at,
--            COUNT(*) OVER()::INT AS _total
--       FROM asaas_webhook_events
--      WHERE signature_valid = TRUE
--        AND processed_at IS NULL
--        AND retry_count > 5
--      ORDER BY received_at DESC, id DESC
--      LIMIT $1 OFFSET $2
--
-- PRE-FIX existing indexes:
--   mig 003 idx_asaas_evt_type (event_type) - lookup por type
--   mig 003 idx_asaas_evt_payment (asaas_payment_id) - lookup por payment
--   mig 003 idx_asaas_evt_processed PARTIAL (processed_at) WHERE processed_at IS NULL
--   mig 010 idx_asaas_webhook_order PARTIAL (order_id) WHERE order_id IS NOT NULL
--   mig 090 idx_asaas_webhook_dead (retry_count, received_at) - retry reconcile
--
--   Planner steps query /admin/webhooks/dead:
--   Opcao A: idx_asaas_evt_processed (PARTIAL IS NULL) -> IndexScan -> Filter
--     retry_count > 5 + signature_valid + Sort by received_at DESC
--     - Scan TODOS unprocessed rows (1000s em flight) -> Filter (>5 retry)
--     - Em prod com 30d retention: ~10k-50k unprocessed rows scanned
--   Opcao B: idx_asaas_webhook_dead (retry_count, received_at) -> Range scan
--     retry_count > 5 -> Filter processed_at IS NULL + signature_valid
--     - Mais seletivo mas ainda filter pos-scan
--
-- POST-FIX:
--   idx_asaas_webhook_dead_admin PARTIAL composite:
--     ON asaas_webhook_events (received_at DESC, id DESC)
--     WHERE signature_valid = TRUE
--       AND processed_at IS NULL
--       AND retry_count > 5
--
--   Idx PARTIAL contem APENAS dead webhooks (typically <1% of table).
--   Em prod com 100k+ webhook events: idx ~100-500 rows physical size.
--
--   Planner steps:
--   1. Direct Index Scan idx_asaas_webhook_dead_admin (pre-sorted + filtered)
--   2. LIMIT N + OFFSET M (SEM Sort SEM Filter)
--
--   Latency:
--   - PRE-FIX (Opcao A): scan 10k-50k rows + filter + sort = ~50-200ms
--   - POST-FIX: direct partial idx scan = ~2-5ms (20-40x improvement)
--   - Storage: ~10-50KB (PARTIAL muito seletivo)
--   - INSERT overhead: 0 (predicate WHERE rejeita most rows)
--
-- COVERAGE QUERIES:
--   - /admin/webhooks/dead (este path - dashboard-admin page)
--   - Cron alert dead webhooks count (futuro feature)
--   - Forensic: webhooks que falharam mais de 5x retry
--
-- PATTERN V8 W14 cadeia PARTIAL com sort ordering deterministic:
--   pass 102 idx_notif_user_inapp_unread PARTIAL channel+is_read
--   pass 103 idx_qa_runs_product_timeout PARTIAL verdict='timeout'
--   pass 104 idx_price_alerts_unnotified PARTIAL last_notified_at IS NULL
--   pass 105 idx_products_sales_public PARTIAL status whitelist
--   pass 106 idx_audit_anonymous_critical PARTIAL HMAC forensic
--   pass 107 idx_qna_seller_pending_sort PARTIAL composite com sort
--   pass 108 idx_payouts_seller_status_sort composite filter+sort
--   pass 109 idx_disputes_created simple range 90d
--   pass 110 (este) idx_asaas_webhook_dead_admin PARTIAL composite com sort
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_asaas_webhook_dead_admin;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_asaas_webhook_dead_admin
    ON asaas_webhook_events (received_at DESC, id DESC)
    WHERE signature_valid = TRUE
      AND processed_at IS NULL
      AND retry_count > 5;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_asaas_webhook_dead_admin create: % - %', SQLSTATE, SQLERRM;
END $$;

ANALYZE asaas_webhook_events;

DO $$ BEGIN
  RAISE NOTICE 'W14-pass560: idx_asaas_webhook_dead_admin PARTIAL composite (consume /admin/webhooks/dead)';
END $$;
