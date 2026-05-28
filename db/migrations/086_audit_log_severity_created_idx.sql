-- Migration 086: idx composto audit_log (severity, created_at DESC)
-- W14 pass 360 - 2026-05-28
--
-- CONTEXTO:
-- Endpoint admin /api/aiops/audit-log filtra por ?severity=warn|error|critical
-- e ordena por created_at DESC com window COUNT (pass 200).
--
-- INDICES EXISTENTES (mig 002 audit_log):
-- - idx_audit_actor (actor_user_id)
-- - idx_audit_action (action)
-- - idx_audit_target (target_type, target_id)
-- - idx_audit_severity (severity) WHERE severity IN ('error','critical')   PARCIAL
-- - idx_audit_created (created_at DESC)
-- - idx_audit_payload_gin (payload_after) GIN
-- - idx_audit_action_created (action, created_at DESC)  mig 037 (W14-9)
-- - idx_audit_actor_created (actor_user_id, created_at DESC) mig 058
--
-- LACUNA:
-- - idx_audit_severity PARCIAL exclui severity='warn' (terceiro mais comum)
-- - Filter combo "severity=warn + created_at > 7d" forca:
--   1. idx_audit_created scan -> Filter on severity (Bitmap Heap)
--   2. ou Seq Scan se rows estimados > X% (PG escolhe pior pior plan)
-- - Audit_log produo ~450k rows (comment aiops-svc linha 490)
--   * severity='info' = ~70% (skip - cardinality baixa, idx waste)
--   * severity='warn' = ~25% (TARGET - precisa idx)
--   * severity='error' = ~4% (coberto pelo idx parcial existing)
--   * severity='critical' = ~1% (idx parcial)
--
-- POST-FIX: idx composto (severity, created_at DESC) PARTIAL excluindo 'info'.
-- - 'info' nao precisa idx (low value, high volume - Seq Scan eh fine)
-- - 'warn|error|critical' = forense actionable (dashboard polling diario)
-- - ORDER BY created_at DESC ja inclusa no idx -> no Sort node
-- - Filter severity='warn' + created_at DESC = pure index scan
--
-- LATENCIA esperada (450k rows base):
-- - PRE: ~150-300ms (Bitmap Heap idx_audit_created + Filter severity)
-- - POST: ~5-20ms (Index Scan idx_audit_severity_created direct)
--
-- TRADE-OFF: idx write em CADA audit_log INSERT (~10-100/min produo).
-- Aceitavel - audit_log eh write-heavy MAS dashboard read latency
-- importa mais (admin UX + compliance forense).
--
-- ROLLBACK: DROP INDEX IF EXISTS idx_audit_severity_created;

CREATE INDEX IF NOT EXISTS idx_audit_severity_created
  ON audit_log(severity, created_at DESC)
  WHERE severity IN ('warn','error','critical');

ANALYZE audit_log;

DO $$
BEGIN
  RAISE NOTICE 'W14-pass360: idx_audit_severity_created (severity+created_at PARTIAL warn|error|critical)';
END $$;
