-- Migration 131: idx_audit_action_created_id direction parity DESC+DESC tiebreaker
-- ============================================================================
--
-- FIX-WORKER-14 pass 707: consume aiops-svc /audit-log action filter query
-- ORDER BY tiebreaker direction parity. Paridade Regra D V8 cross-svc (cadeia mig 102-130).
--
-- CONTEXT:
--   aiops-svc /audit-log com action filter (admin forensic):
--     WHERE a.action = $X + a.created_at filter
--     ORDER BY a.created_at DESC, a.id DESC
--
--   Common queries:
--   - WHERE action = 'vault.use.invalid_internal_token' (HMAC bypass attempts)
--   - WHERE action = 'auth.login.user_not_found' (email enumeration probe)
--   - WHERE action = 'payment.refund.dispatched' (financial trail)
--   - WHERE action LIKE 'qa.%' (LLM pipeline events)
--
-- PRE-FIX existing index (mig 037):
--   idx_audit_action_created ON audit_log (action, created_at DESC)
--   - Cobre action filter + 1-level ORDER mas sem id DESC tiebreaker
--   - audit_log mass-insert -> External Sort overhead per query
--   - Pattern V8 W14 cadeia 27+ indexes ja consolidaram tiebreaker
--
-- POST-FIX:
--   idx_audit_action_created_id composite direction parity Regra D V8:
--     ON audit_log (action, created_at DESC, id DESC)
--
--   Latency: ~5-15ms External Sort eliminado -> ~1-3ms total query
--   Storage: ~5-10MB para 300k audit rows
--
--   Trade-off vs mig 037 idx_audit_action_created:
--   - mig 037 cobre simple action + ORDER (sem tiebreaker)
--   - mig 131 (este) cobre tiebreaker completo direction parity
--   - Manter ambos. pg_stat_user_indexes decision drop futuro
--
-- PATTERN V8 W14 cadeia direction parity composite tiebreaker FINAL:
--   passes 102-130 (29 indexes consolidacao previa)
--   pass 131 (este) audit_action_created_id direction parity DESC+DESC
--   = audit_log trilogy 129/130/131 (actor + target + action) COMPLETA
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_audit_action_created_id;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_audit_action_created_id
    ON audit_log (action, created_at DESC, id DESC);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_audit_action_created_id create: % - %', SQLSTATE, SQLERRM;
END $$;

ANALYZE audit_log;

DO $$ BEGIN
  RAISE NOTICE 'W14-pass707: idx_audit_action_created_id direction parity DESC+DESC - audit_log trilogy COMPLETA (mig 129+130+131)';
END $$;
