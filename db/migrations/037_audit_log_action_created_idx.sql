-- FIX-WORKER-14 pass 9: indice composto audit_log (action, created_at DESC)
--
-- CONTEXTO:
-- W11 pass 8 + W17 pass 13 adicionaram actions novas ao audit_log:
-- - 'webhook.reset' (admin reset de webhook stuck)
-- - 'vault.rotate' (rotacao atomic de chaves)
-- - 'notification.test_email_sent' (W13 pass 6 - admin testes)
-- - + actions ja existentes: 'product.force_approve', 'seller.suspend', etc.
--
-- Query padrao admin: "ultimas 50 acoes de tipo X"
--   SELECT * FROM audit_log
--    WHERE action = $1
--    ORDER BY created_at DESC LIMIT 50;
--
-- INDICES EXISTENTES:
-- - idx_audit_action (action) - seleciona linhas
-- - idx_audit_created (created_at DESC) - sort
-- - idx_audit_target (target_type, target_id) - lookup por entity
--
-- GAP: para a query acima, Postgres faz:
-- 1. Bitmap Index Scan idx_audit_action (rows por action)
-- 2. SORT externo por created_at DESC (memoria/disk)
-- 3. LIMIT 50
--
-- Em audit_log com cleanup 90d (W14 pass anterior), volume estimado:
-- ~5k rows/dia * 90d = 450k rows. Sort de 10k rows (action='login_success') em
-- memoria ~50ms. Multiplas actions concorrentes na admin dashboard = lag visivel.
--
-- FIX: indice composto (action, created_at DESC) - 1 scan ordenado, LIMIT 50
-- pega so 50 linhas sem sort. ~50ms -> <1ms.
--
-- PADRAO: WHERE col1 = X ORDER BY col2 DESC -> indice (col1, col2 DESC).
-- Mesmo template aplicado em W14 pass 5 (payouts) e pass 6 (qa_runs).

CREATE INDEX IF NOT EXISTS idx_audit_action_created
  ON audit_log (action, created_at DESC);

COMMENT ON INDEX idx_audit_action_created IS
  'W14-9: composto p/ admin "ultimas N acoes por tipo". Elimina sort externo.';

-- Validacao pos-apply:
--   EXPLAIN ANALYZE SELECT * FROM audit_log
--    WHERE action = 'vault.rotate'
--    ORDER BY created_at DESC LIMIT 50;
--   Esperado: Index Scan using idx_audit_action_created (sem Sort node)

-- NOTA SOBRE idx_audit_action simples (action apenas):
-- Pode virar redundante (composto cobre WHERE action=X tambem).
-- Decisao: MANTER por enquanto. Avaliar drop em W14 pass 10 apos 2 semanas de
-- pg_stat_user_indexes confirmar zero scans em idx_audit_action.

DO $$
BEGIN
  RAISE NOTICE 'W14-9: indice idx_audit_action_created criado (admin audit queries)';
END $$;
