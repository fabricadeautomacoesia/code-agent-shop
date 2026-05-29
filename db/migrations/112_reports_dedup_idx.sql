-- Migration 112: idx_reports_dedup composite (consume POST /reports dedup query)
-- ============================================================================
--
-- FIX-WORKER-14 pass 581: consume review-svc POST /reports dedup 7d query
--
-- CONTEXT:
--   review-svc POST /reports endpoint (linha 1137-1141) - anti-spam dedup check
--   antes do INSERT. Cada nova report request executa este SELECT.
--
--   Query padrao (anti-spam dedup 7d window):
--     SELECT 1 FROM reports
--      WHERE reporter_user_id = $1::UUID
--        AND target_type = $2
--        AND target_id = $3::UUID
--        AND reason_code = $4
--        AND created_at > NOW() - INTERVAL '7 days'
--      LIMIT 1
--
-- PRE-FIX existing indexes reports (mig 011 + 049 + 101):
--   idx_reports_target (target_type, target_id) - filter target match
--   idx_reports_status (status) - admin queue filter
--   idx_reports_created (created_at DESC) - sort apenas
--   idx_reports_reporter_user_id (reporter_user_id) - filter reporter match
--   idx_reports_resolved_by PARTIAL (resolved_by) NOT NULL
--   mig 101 idx_reports_status_created (status, created_at DESC, id DESC) - admin queue
--
--   GAP: dedup query combina 4 conditions exact match + 1 time range.
--   Nenhum idx existente cobre composite. Planner forced:
--   - Opcao A: idx_reports_target + Filter reporter + reason + 7d window
--   - Opcao B: idx_reports_reporter + Filter target + reason + 7d
--   Ambos requerem post-Filter heavy. Em prod com 10k+ reports acumulados:
--   - Latency: ~5-20ms per request (small overhead, mas N+1 amplifica)
--   - Cada POST /reports = 1 query dedup + 1 INSERT
--   - User legit submits 1 report/dia OK, mas anti-spam path hot:
--     atacante probing dedup logic = thousands req/min hit DB direto
--
-- POST-FIX:
--   idx_reports_dedup composite p/ exact match path:
--     ON reports (reporter_user_id, target_type, target_id, reason_code, created_at DESC)
--
--   Planner steps:
--   1. Direct Index Lookup (4-col exact match) + range scan created_at
--   2. LIMIT 1 (short-circuit)
--   Sem Filter post-scan. ~1-2ms (idx lookup) vs 5-20ms PRE-FIX.
--
--   Trade-off vs PARTIAL approach:
--   - PARTIAL WHERE created_at > NOW() - 7d nao funciona (PG nao suporta
--     time-dependent predicate em CREATE INDEX - precisaria reindex daily)
--   - Composite simples cobre query completa + idx usage stat clara via
--     pg_stat_user_indexes (decide future drop if low scans)
--
-- COVERAGE QUERIES:
--   - POST /reports dedup check (este path - hot path anti-spam)
--   - Future: admin investigation 'todas reports de user X contra seller Y'
--   - Forensic: pattern detection reporter cluster (multi-target spam)
--
-- PATTERN V8 W14 cadeia composite multi-col exact match:
--   pass 102 idx_notif_user_inapp_unread PARTIAL channel+is_read
--   pass 103 idx_qa_runs_product_timeout PARTIAL verdict='timeout'
--   pass 104 idx_price_alerts_unnotified PARTIAL last_notified_at IS NULL
--   pass 105 idx_products_sales_public PARTIAL status whitelist
--   pass 106 idx_audit_anonymous_critical PARTIAL HMAC forensic
--   pass 107 idx_qna_seller_pending_sort PARTIAL composite sort
--   pass 108 idx_payouts_seller_status_sort composite filter+sort
--   pass 109 idx_disputes_created simple range
--   pass 110 idx_asaas_webhook_dead_admin PARTIAL composite
--   pass 111 idx_qa_runs_llm_cost PARTIAL range 30d cost
--   pass 112 (este) idx_reports_dedup composite multi-col exact match
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_reports_dedup;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_reports_dedup
    ON reports (reporter_user_id, target_type, target_id, reason_code, created_at DESC);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_reports_dedup create: % - %', SQLSTATE, SQLERRM;
END $$;

ANALYZE reports;

DO $$ BEGIN
  RAISE NOTICE 'W14-pass581: idx_reports_dedup composite (consume POST /reports anti-spam dedup 7d)';
END $$;
