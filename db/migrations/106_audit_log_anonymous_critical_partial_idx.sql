-- Migration 106: idx_audit_anonymous_critical PARTIAL (HMAC bypass forensic)
-- ============================================================================
--
-- FIX-WORKER-14 pass 524: consume cadeia HMAC/token bypass audit (passes 458/462/463/523)
--
-- CONTEXT:
--   Cross-svc cadeia HMAC/token validation failures inserts audit_log:
--     vault.invalid_internal_token (pass 458) -> actor=NULL, role=anonymous, severity=critical
--     qa.callback.invalid_signature (pass 462) -> idem
--     asaas.webhook.invalid_signature (pass 463) -> idem
--     qa.run.invalid_internal_token (pass 523) -> idem
--
--   Admin investigation forensic query:
--     SELECT * FROM audit_log
--      WHERE actor_role = 'anonymous'
--        AND severity = 'critical'
--        AND created_at > NOW() - INTERVAL '7 days'
--      ORDER BY created_at DESC LIMIT 50;
--
--   Padrao de query: "Quais HMAC bypass attempts nos ultimos 7d?"
--
-- PRE-FIX existing indexes (audit_log):
--   002:195 idx_audit_actor (actor_user_id) - NULL actors skip
--   002:196 idx_audit_action (action) - non-composite
--   002:197 idx_audit_target (target_type, target_id)
--   002:198 idx_audit_severity PARTIAL WHERE severity IN ('error','critical')
--   002:199 idx_audit_created (created_at DESC)
--   037:35  idx_audit_action_created (action, created_at DESC)
--   086     idx_audit_severity_created PARTIAL warn+
--   094     idx_audit_target_created PARTIAL NOT NULL
--   098     idx_audit_target_type_severity PARTIAL critical
--
--   GAP: NENHUM idx em actor_role coluna!
--   - WHERE actor_role='anonymous' AND severity='critical' AND created_at > N
--   - Planner usa idx_audit_severity (filter critical) + Heap Filter actor_role
--   - Em prod com 100k+ audit_log rows: ~5% critical (5k) + filter anonymous
--   - Anonymous rows raros (HMAC bypass = poucos eventos legitimate)
--   - Heap Filter caro pra 5k rows -> ~30ms scan
--
-- POST-FIX:
--   idx_audit_anonymous_critical PARTIAL composite:
--     ON audit_log (created_at DESC, id DESC)
--     WHERE actor_role = 'anonymous'
--       AND severity = 'critical'
--
--   Cobertura:
--   - Predicate literal immutable (actor_role enum + severity enum)
--   - Idx physical TINY (<1% audit_log rows em prod healthy)
--   - 0 rows em prod ideal (sem HMAC attacks) - idx vazio ate primeiro incident
--   - Direct Index Scan pre-sorted DESC (sem Sort node)
--   - Tiebreaker id DESC (Pattern V8 Regra D pass 251 - mass-insert burst)
--
--   Trade-off:
--   - Storage: minimal (~1KB para 100 anonymous critical rows)
--   - INSERT cost: +1 idx write APENAS para actor_role=anonymous+severity=critical
--   - Throughput audit_log INSERTs nao impactado (99%+ skip predicate)
--
-- COVERAGE QUERIES:
--   - Admin /admin/audit-log forensic anonymous critical investigation
--   - Future: AIOPS alert detection cron HMAC bypass spike
--   - SOC2 + LGPD compliance reports (anonymous critical = high-value events)
--
-- LATENCIA ESPERADA:
--   - Pre-fix: idx_audit_severity + Heap Filter actor_role -> ~30ms
--   - Post-fix: Direct Index Scan PARTIAL -> ~2ms
--   - 15x improvement em forensic queries
--
-- PATTERN V8 W14 cadeia PARTIAL com literal predicates:
--   pass 086 idx_audit_severity_created PARTIAL warn+
--   pass 094 idx_audit_target_created PARTIAL NOT NULL
--   pass 098 idx_audit_target_type_severity PARTIAL critical
--   pass 100 idx_pwreset_pending_unused PARTIAL used_at IS NULL
--   pass 102 idx_notif_user_inapp_unread PARTIAL channel+is_read
--   pass 103 idx_qa_runs_product_timeout PARTIAL verdict
--   pass 104 idx_price_alerts_unnotified PARTIAL last_notified_at IS NULL
--   pass 105 idx_products_sales_public PARTIAL W7 status whitelist
--   pass 106 (este) idx_audit_anonymous_critical PARTIAL anonymous + critical
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_audit_anonymous_critical;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_audit_anonymous_critical
    ON audit_log (created_at DESC, id DESC)
    WHERE actor_role = 'anonymous'
      AND severity = 'critical';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_audit_anonymous_critical create: % - %', SQLSTATE, SQLERRM;
END $$;

ANALYZE audit_log;

DO $$ BEGIN
  RAISE NOTICE 'W14-pass524: idx_audit_anonymous_critical PARTIAL (consume HMAC bypass forensic cadeia 458/462/463/523)';
END $$;
