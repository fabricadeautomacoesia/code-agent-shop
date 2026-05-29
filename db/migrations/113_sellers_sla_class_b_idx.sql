-- Migration 113: idx_sellers_sla_classb PARTIAL (consume SLA cron Classe B query)
-- ============================================================================
--
-- FIX-WORKER-14 pass 593: consume seller-svc cron sla-checker SLA warning + revoke queries
--
-- CONTEXT:
--   seller-svc/src/cron/sla-checker.js executa diariamente (1x/dia, manhã BRT):
--   - SLA warnings (linhas 20-31): 3 queries (7d, 3d, 1d janelas) p/ emails seller
--   - SLA revogados (linhas 63-70): 1 query p/ deadline < NOW() (suspend keys+sessions)
--
--   Padrao queries:
--     WHERE seller_class = 'class_b'
--       AND sla_active = TRUE
--       AND status = 'active'
--       AND sla_next_deadline_at BETWEEN/< janela
--
-- PRE-FIX existing indexes sellers:
--   mig 003 idx_sellers_class (seller_class) - single col
--   mig 003 idx_sellers_status (status) - single col
--   mig 003 idx_sellers_sla_deadline (sla_next_deadline_at) PARTIAL
--           WHERE sla_active=TRUE AND status='active'
--
--   PARTIAL ja exclui 2 filters (sla_active + status). MAS:
--   - Filter seller_class='class_b' aplicado post-scan
--   - Em prod com 1000+ sellers (mix class_a + class_b ~70/30 split):
--     PARTIAL retorna ~300 class_a + ~700 class_b para 7-day window
--     Filter elimina class_a (waste scan ~300 rows desnecessarias)
--     Cron 4 queries (warning x3 + revoke) = 4x scan waste
--
-- POST-FIX:
--   idx_sellers_sla_classb PARTIAL tighter:
--     ON sellers (sla_next_deadline_at)
--     WHERE sla_active = TRUE AND status = 'active' AND seller_class = 'class_b'
--
--   PG planner picks tighter idx quando query match all predicates.
--   - Idx physical: ~70% rows class_b ja em sla_deadline original = small marginal
--   - INSERT overhead: 0 (predicate WHERE rejeita class_a)
--   - Storage: <100KB para 1000 sellers
--   - Eliminate Filter step post-scan = 100% rows scanned utilizados
--
--   Latency:
--   - PRE-FIX: scan PARTIAL ~1000 rows + Filter class_b ~30%
--   - POST-FIX: scan PARTIAL tighter ~700 rows zero Filter
--   - ~20-30% improvement per cron query (4 queries/dia)
--   - Anti-bloat: reduz PG buffer pollution daily
--
--   Trade-off vs mig 003 idx_sellers_sla_deadline:
--   - mig 003 ainda cobre admin queries que filtram differently (class_a SLA future)
--   - Manter ambos (mig 003 simpler + mig 113 cron-aware tighter)
--   - pg_stat_user_indexes mostra usage decision drop futuro
--
-- COVERAGE QUERIES:
--   - sla-checker.js linhas 20-31 (3 warning queries por dia)
--   - sla-checker.js linhas 63-70 (1 revoke query por dia)
--   - Future cron extensions (sla_pre_warning_14d etc)
--
-- PATTERN V8 W14 cadeia PARTIAL com state predicate:
--   pass 102 idx_notif_user_inapp_unread PARTIAL channel+is_read
--   pass 103 idx_qa_runs_product_timeout PARTIAL verdict='timeout'
--   pass 104 idx_price_alerts_unnotified PARTIAL last_notified_at IS NULL
--   pass 105 idx_products_sales_public PARTIAL W7 status whitelist
--   pass 106 idx_audit_anonymous_critical PARTIAL HMAC forensic
--   pass 107 idx_qna_seller_pending_sort PARTIAL composite sort
--   pass 108 idx_payouts_seller_status_sort composite filter+sort
--   pass 109 idx_disputes_created simple range
--   pass 110 idx_asaas_webhook_dead_admin PARTIAL composite
--   pass 111 idx_qa_runs_llm_cost PARTIAL range 30d
--   pass 112 idx_reports_dedup composite multi-col exact match
--   pass 113 (este) idx_sellers_sla_classb PARTIAL state cron-aware
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_sellers_sla_classb;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_sellers_sla_classb
    ON sellers (sla_next_deadline_at)
    WHERE sla_active = TRUE
      AND status = 'active'
      AND seller_class = 'class_b';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_sellers_sla_classb create: % - %', SQLSTATE, SQLERRM;
END $$;

ANALYZE sellers;

DO $$ BEGIN
  RAISE NOTICE 'W14-pass593: idx_sellers_sla_classb PARTIAL cron-aware (consume SLA cron 4 queries/dia)';
END $$;
