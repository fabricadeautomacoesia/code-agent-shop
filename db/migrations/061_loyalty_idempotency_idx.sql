-- Migration 061: indice idempotency loyalty_transactions (user_id, reason, reference_id)
-- W14 pass 190 - 2026-05-28
--
-- CONTEXTO:
-- POST /loyalty/earn (seller-svc) eh chamado em CADA order checkout via order-svc.
-- Idempotency check (W7 pass 45 BUG 2 fix) faz:
--
--   SELECT id, created_at FROM loyalty_transactions
--    WHERE user_id = $1::UUID
--      AND reason = $2
--      AND reference_id = $3
--    LIMIT 1
--
-- Cenario: user replay POST mesmo reference_id 10x -> SEM idempotency, earn 10x.
-- Pattern protege contra: order-svc retry (network blip), client double-click,
-- attacker tentando spam.
--
-- INDICES EXISTENTES:
--   idx_loyalty_user        (user_id, created_at DESC) - cobre listings
--   idx_loyalty_user_recent (user_id, created_at DESC) - DUPLICATE de idx_loyalty_user!
--
-- GAP: query idempotency NAO matcha indice acima (precisa filter reason+ref).
-- PG path: Index Scan idx_loyalty_user + Filter reason+reference_id pos-scan.
-- Em heavy user com 1000+ tx, scan + filter ~30ms (deveria ser <2ms).
--
-- FIX: partial UNIQUE index (user_id, reason, reference_id) WHERE reference_id IS NOT NULL.
-- Por que UNIQUE:
--   - Pattern V8 idempotency: DB enforce + app graceful (ON CONFLICT IGNORE)
--   - Atualmente app SELECT-then-INSERT race-prone (mesmo bug pass 184 Asaas
--     webhook). Migration prepara DB para POST migration app refactor.
--   - Partial WHERE reference_id IS NOT NULL: admin_adjust sem ref OK duplicate.
--
-- WHY NAO REMOVE idx_loyalty_user_recent (duplicate):
--   pg_stat_user_indexes vai mostrar se ambos usam. W14 futura podera DROP.
--   Por agora, manter (overhead minimo, ~10MB tipico).

-- PASSO 1: Verificar colisoes (UNIQUE constraint exige zero duplicates atuais)
DO $$
DECLARE
  collision_count INT;
BEGIN
  SELECT COUNT(*) INTO collision_count
  FROM (
    SELECT user_id, reason, reference_id, COUNT(*) AS dup_count
      FROM loyalty_transactions
     WHERE reference_id IS NOT NULL
     GROUP BY user_id, reason, reference_id
    HAVING COUNT(*) > 1
  ) collisions;

  IF collision_count > 0 THEN
    RAISE WARNING 'W14-pass190: % colisoes em (user_id,reason,reference_id) encontradas.', collision_count;
    RAISE WARNING 'UNIQUE skip - criar so como BTREE composite (sem enforce).';
    RAISE WARNING 'Query investigar: SELECT user_id, reason, reference_id, COUNT(*) FROM loyalty_transactions WHERE reference_id IS NOT NULL GROUP BY 1,2,3 HAVING COUNT(*) > 1;';

    -- Fallback: indice non-unique (otimizacao still)
    CREATE INDEX IF NOT EXISTS idx_loyalty_idempotency
      ON loyalty_transactions (user_id, reason, reference_id)
      WHERE reference_id IS NOT NULL;
    RAISE NOTICE 'W14-pass190: idx_loyalty_idempotency NON-UNIQUE criado (admin cleanup duplicates depois p/ UNIQUE).';
  ELSE
    RAISE NOTICE 'W14-pass190: zero colisoes - criando UNIQUE index.';

    CREATE UNIQUE INDEX IF NOT EXISTS idx_loyalty_idempotency
      ON loyalty_transactions (user_id, reason, reference_id)
      WHERE reference_id IS NOT NULL;
    RAISE NOTICE 'W14-pass190: idx_loyalty_idempotency UNIQUE criado (enforce idempotency DB-side).';
  END IF;
END $$;

COMMENT ON INDEX IF EXISTS idx_loyalty_idempotency IS
  'W14-pass190: partial UNIQUE idempotency p/ POST /loyalty/earn check (user_id+reason+reference_id). Substitui SELECT-then-INSERT race-prone por ON CONFLICT pattern (future app refactor).';

-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_loyalty_idempotency;

-- VALIDACAO POS-APPLY:
--   EXPLAIN ANALYZE SELECT id, created_at FROM loyalty_transactions
--    WHERE user_id = '<uuid>' AND reason = 'purchase' AND reference_id = 'order_x';
--   Esperado: Index Scan using idx_loyalty_idempotency (sem Filter step)
--   Latencia: ~30ms (filter post-scan) -> <2ms (index direct lookup)
