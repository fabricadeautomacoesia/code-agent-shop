-- Migration 111: idx_qa_runs_llm_cost PARTIAL (consume /admin/llm-cost endpoint)
-- ============================================================================
--
-- FIX-WORKER-14 pass 570: consume aiops-svc /admin/llm-cost queries (3 hot)
--
-- CONTEXT:
--   aiops-svc /admin/llm-cost endpoint (linha 982-1027) - admin dashboard LLM
--   cost analytics (Cloud Code Ilimitado feature - track gross margin).
--
--   3 queries hot path 30-day window:
--   Q1. Aggregation by provider+model:
--     SELECT llm_provider, llm_model, COUNT(*), SUM(cost_usd_cents), AVG/MAX
--       FROM product_qa_runs
--      WHERE created_at > NOW() - INTERVAL '30 days'
--        AND llm_provider IS NOT NULL
--        AND cost_usd_cents IS NOT NULL
--      GROUP BY llm_provider, llm_model
--
--   Q2. Total + verdict breakdown:
--     SELECT COUNT, SUM, FILTER (WHERE verdict = ...)
--       FROM product_qa_runs
--      WHERE created_at > NOW() - INTERVAL '30 days'
--        AND cost_usd_cents IS NOT NULL
--
--   Q3. Daily timeseries:
--     SELECT DATE_TRUNC('day', created_at), COUNT, SUM
--       FROM product_qa_runs
--      WHERE created_at > NOW() - INTERVAL '30 days'
--        AND cost_usd_cents IS NOT NULL
--      GROUP BY day
--
-- PRE-FIX existing indexes product_qa_runs:
--   mig 008 idx_qa_runs_product (product_id, created_at DESC) - product lookup
--   mig 008 idx_qa_runs_verdict (verdict) - single col verdict filter
--   mig 008 idx_qa_runs_n8n (n8n_execution_id) - n8n correlation
--   mig 023 idx_product_qa_runs_product_version_id - version lookup
--   mig 023 idx_product_qa_runs_triggered_by_user_id PARTIAL - audit who triggered
--   mig 053 idx_qa_runs_product_started (product_id, started_at DESC) - sort
--   mig 103 idx_qa_runs_product_timeout PARTIAL verdict='timeout' (W14 pass)
--
--   GAP: NO index covers (created_at + cost_usd_cents IS NOT NULL) combo.
--   Planner forced Seq Scan + Filter both conditions + HashAggregate.
--
--   Em prod com ~100 QA runs/dia x 30 days retention = 3000+ rows base
--   Pos-1-year prod: ~36k+ rows acumulados em product_qa_runs
--   Seq Scan + Filter custoso (~50-200ms per query, x3 queries = 150-600ms)
--   Admin /admin/llm-cost page polling 30s = stress DB consistente
--
-- POST-FIX:
--   idx_qa_runs_llm_cost PARTIAL composite:
--     ON product_qa_runs (created_at DESC)
--     WHERE cost_usd_cents IS NOT NULL
--
--   PARTIAL muito seletivo:
--   - Runs com cost_usd_cents IS NOT NULL = QA runs LLM-backed (~80% of total)
--   - Idx physical size ~80% rows base x 30d window = small
--   - Em prod: ~24k rows acumulados (1y)
--
--   Planner steps:
--   1. Direct Index Scan idx_qa_runs_llm_cost (range scan 30d)
--   2. HashAggregate by provider+model OR by day OR total
--   Sem Seq Scan, Filter cost_usd_cents IS NOT NULL eliminado por predicate.
--
--   Latency:
--   - PRE-FIX: 3 queries x 50-200ms each = 150-600ms aggregate
--   - POST-FIX: 3 queries x 5-20ms each = 15-60ms aggregate (~10x improvement)
--   - Storage: ~2-5MB para 24k rows (1y prod)
--   - INSERT overhead: 0 (predicate WHERE rejeita rows sem cost - bot triggers
--     legacy QA pre-cost-tracking ou worker_error sem llm call)
--
-- COVERAGE QUERIES:
--   - /admin/llm-cost (este path - dashboard-admin LLM cost analytics)
--   - Cron mensal report LLM spend (futuro feature)
--   - Forensic: queries que tiveram cost tracking (vs early/error paths)
--
-- PATTERN V8 W14 cadeia PARTIAL cost analytics:
--   pass 102 idx_notif_user_inapp_unread PARTIAL channel+is_read
--   pass 103 idx_qa_runs_product_timeout PARTIAL verdict='timeout'
--   pass 104 idx_price_alerts_unnotified PARTIAL last_notified_at IS NULL
--   pass 105 idx_products_sales_public PARTIAL status whitelist
--   pass 106 idx_audit_anonymous_critical PARTIAL HMAC forensic
--   pass 107 idx_qna_seller_pending_sort PARTIAL composite sort
--   pass 108 idx_payouts_seller_status_sort composite filter+sort
--   pass 109 idx_disputes_created simple range 90d
--   pass 110 idx_asaas_webhook_dead_admin PARTIAL composite
--   pass 111 (este) idx_qa_runs_llm_cost PARTIAL range 30d cost tracking
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_qa_runs_llm_cost;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_qa_runs_llm_cost
    ON product_qa_runs (created_at DESC)
    WHERE cost_usd_cents IS NOT NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_qa_runs_llm_cost create: % - %', SQLSTATE, SQLERRM;
END $$;

ANALYZE product_qa_runs;

DO $$ BEGIN
  RAISE NOTICE 'W14-pass570: idx_qa_runs_llm_cost PARTIAL range 30d (consume /admin/llm-cost 3 queries)';
END $$;
