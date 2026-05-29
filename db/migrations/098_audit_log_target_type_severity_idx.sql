-- Migration 098: idx_audit_target_type_severity_created (anonymous critical events)
-- ============================================================================
--
-- FIX-WORKER-14 pass 465: consume pass 458+462+463 audit_log critical pattern
--
-- CONTEXT:
--   Passes 458/462/463 introduziram audit_log critical entries com:
--   - actor_user_id = NULL (anonymous external attempts)
--   - target_id = NULL (no specific entity targeted - bypass attempts pre-action)
--   - target_type = 'vault_internal' | 'qa_callback' | 'asaas_webhook'
--   - severity = 'critical'
--
--   Pass 464 + outras admin pages criaram forensic queries:
--     SELECT * FROM audit_log
--      WHERE target_type = $1
--        AND severity = $2
--        AND created_at > NOW() - INTERVAL '$3 days'
--      ORDER BY created_at DESC
--      LIMIT 100
--
-- PRE-FIX:
--   Idx existentes audit_log:
--   - idx_audit_target_created PARTIAL WHERE target_id IS NOT NULL (mig 094 pass 430)
--     -> EXCLUI rows com target_id=NULL (todos events anonymous pass 458/462/463)
--   - idx_audit_severity_created PARTIAL WHERE severity IN ('warn','error','critical') (mig 086)
--     -> ajuda filter severity mas filter target_type lineariza
--
--   Query pass 464 "all critical asaas_webhook 30d":
--   - PG planner usa idx_audit_severity_created (Bitmap critical)
--   - Filter target_type='asaas_webhook' lineariza (~50% rows discarded)
--   - Sort created_at DESC sub-Bitmap (heap fetch)
--   - Latencia esperada ~50ms em deploy maduro (millions audit rows)
--
-- POST-FIX:
--   idx composite (target_type, severity, created_at DESC) PARTIAL severity critical
--   - PG planner usa direct Index Scan pre-sorted
--   - Filter target_type exact + severity critical = Bitmap And Index muito eficiente
--   - Latencia esperada: ~50ms -> ~5ms (10x melhoria)
--
-- COVERAGE QUERIES otimizadas (todas paridade pass 464):
--   - /admin/audit-log?target_type=asaas_webhook&severity=critical (forensic webhooks)
--   - /admin/audit-log?target_type=vault_internal&severity=critical (vault bypass attempts)
--   - /admin/audit-log?target_type=qa_callback&severity=critical (qa HMAC bypass)
--   - Generic: any anonymous critical attack pattern cross-svc
--
-- PARTIAL severity critical apenas:
--   - 'critical' eh severity menos comum (apenas security events maximos)
--   - PARTIAL idx ~10% size de full idx
--   - Custo INSERT desprezivel (1 row write per critical event - raros)
--
-- TRADE-OFF:
--   - idx adicional ocupa ~5-10MB em prod com 1M+ audit_log rows
--   - INSERT overhead +1 idx write SO em critical events (raros - <0.1% writes)
--   - Aceitavel: forensic query latency reduzida 10x
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_audit_target_type_severity_created;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_audit_target_type_severity_created
    ON audit_log(target_type, severity, created_at DESC)
    WHERE severity = 'critical';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_audit_target_type_severity_created create: % - %', SQLSTATE, SQLERRM;
END $$;

-- ANALYZE p/ planner stats fresh
ANALYZE audit_log;

DO $$ BEGIN
  RAISE NOTICE 'W14-pass465: idx_audit_target_type_severity_created PARTIAL critical (consume pass 458+462+463 anonymous bypass attempts forensic)';
END $$;
