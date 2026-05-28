-- Migration 058: indice composto audit_log (actor_user_id, created_at DESC)
-- W14 pass 173 - 2026-05-28
--
-- CONTEXTO:
-- audit_log tem ~5k rows/dia (retention 90d -> ~450k rows).
-- /admin/audit-log frontend hoje filtra so por action/severity/days.
-- Proxima evolucao (planejada): filtro "ver historico de acoes do usuario X"
-- (debugging conta comprometida, investigacao moderacao, etc).
--
-- INDICES EXISTENTES:
--   idx_audit_actor (actor_user_id)        - lookup por usuario, sem sort
--   idx_audit_created (created_at DESC)    - sort global
--   idx_audit_action_created (action, created_at DESC) - W14-9
--   idx_audit_target (target_type, target_id)
--   idx_audit_severity partial WHERE severity IN ('error','critical')
--
-- GAP IDENTIFICADO:
-- Query "ultimas 50 acoes do usuario X":
--   SELECT * FROM audit_log
--    WHERE actor_user_id = $1
--    ORDER BY created_at DESC LIMIT 50;
--
-- Plano atual: Bitmap Index Scan idx_audit_actor -> Sort externo -> Limit.
-- Em audit_log com 450k rows, usuario power admin pode ter 5k actions:
-- sort de 5k rows em mem ~30-50ms. Multiplas queries concorrentes em dashboard
-- audit /user/[id] = lag visivel.
--
-- FIX: indice composto (actor_user_id, created_at DESC) - 1 Index Scan ordenado,
-- LIMIT 50 le so 50 pages contiguas. ~50ms -> <2ms.
--
-- PARTIAL: nao precisa actor_user_id IS NULL (sistema actions cron) - reduzir tamanho.
-- Indice base idx_audit_actor ja cobre lookups gerais por actor_user_id.
--
-- PADRAO: WHERE col1 = X ORDER BY col2 DESC -> indice (col1, col2 DESC).
-- Mesmo template aplicado em pass 5 (payouts), 6 (qa_runs), 9 (audit_log action).

CREATE INDEX IF NOT EXISTS idx_audit_actor_created
  ON audit_log (actor_user_id, created_at DESC)
  WHERE actor_user_id IS NOT NULL;

COMMENT ON INDEX idx_audit_actor_created IS
  'W14-pass173: composto p/ admin "historico audit do usuario X". Elimina sort externo. Partial exclui actions de sistema (actor_user_id NULL).';

-- Validacao pos-apply:
--   EXPLAIN ANALYZE SELECT * FROM audit_log
--    WHERE actor_user_id = '<some_user_uuid>'
--    ORDER BY created_at DESC LIMIT 50;
--   Esperado: Index Scan using idx_audit_actor_created (sem Sort node)

-- NOTA SOBRE idx_audit_actor simples:
-- Pode virar redundante (composto cobre WHERE actor_user_id=X tambem).
-- Decisao: MANTER por enquanto. Avaliar drop em pass futuro apos 2 semanas de
-- pg_stat_user_indexes confirmar zero scans em idx_audit_actor.

DO $$
BEGIN
  RAISE NOTICE 'W14-pass173: indice idx_audit_actor_created criado (admin user audit queries)';
END $$;

-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_audit_actor_created;
