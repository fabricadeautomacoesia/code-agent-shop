-- Migration 060: normaliza users.email para lowercase + trim
-- W6 pass 182 - 2026-05-28
--
-- CONTEXTO:
-- App pass 182 introduziu .transform(lowercase+trim) em Zod schemas
-- (register, login, forgot-password). Mas rows historicas podem ter
-- 'John@Example.com' / ' user@email.com ' / 'USER@email.com'.
-- Pos-fix app: novo login normaliza input para lowercase, mas DB SELECT
-- WHERE email = 'lower' nao matcha row stored 'John@Example.com'.
--
-- STRATEGY:
-- 1. Verifica colisoes (2 users iguais case-insensitive)
--    -> Se houver, abort + log para admin cleanup manual.
-- 2. Se OK, UPDATE em batch lower(trim(email)) WHERE diferente.
-- 3. CREATE INDEX UNIQUE LOWER(email) p/ enforce future.
--
-- ROLLBACK:
-- - Indice unique drop (DROP INDEX IF EXISTS idx_users_email_lower_unique)
-- - UPDATE nao reversivel (case info perdido) - aceitavel pq case-sensitive
--   em email eh anti-pattern (RFC 5321 local-part technically case-sensitive
--   mas no mundo real todos email providers tratam case-insensitive)

-- PASSO 1: Verificar colisoes case-insensitive
DO $$
DECLARE
  collision_count INT;
BEGIN
  SELECT COUNT(*) INTO collision_count
  FROM (
    SELECT LOWER(TRIM(email)) AS norm_email, COUNT(*) AS dup_count
      FROM users
     WHERE deleted_at IS NULL
     GROUP BY LOWER(TRIM(email))
    HAVING COUNT(*) > 1
  ) collisions;

  IF collision_count > 0 THEN
    RAISE WARNING 'W6-pass182: % colisoes case-insensitive detectadas em users.email. UPDATE skip - investigar manual primeiro.', collision_count;
    RAISE WARNING 'Query: SELECT LOWER(email), COUNT(*) FROM users WHERE deleted_at IS NULL GROUP BY LOWER(email) HAVING COUNT(*) > 1;';
  ELSE
    RAISE NOTICE 'W6-pass182: zero colisoes - aplicando UPDATE normalize.';

    -- PASSO 2: UPDATE normaliza apenas rows com diferenca
    UPDATE users
       SET email = LOWER(TRIM(email)), updated_at = NOW()
     WHERE deleted_at IS NULL
       AND email != LOWER(TRIM(email));

    RAISE NOTICE 'W6-pass182: % rows normalizadas.', ROW_COUNT;

    -- PASSO 3: indice UNIQUE LOWER(email) defesa em profundidade futura
    -- (mesmo que app esquece transform, DB rejeita case-conflict)
    BEGIN
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower_unique
        ON users (LOWER(email))
        WHERE deleted_at IS NULL;
      RAISE NOTICE 'W6-pass182: idx_users_email_lower_unique criado.';
    EXCEPTION WHEN duplicate_table OR duplicate_object THEN
      RAISE NOTICE 'W6-pass182: idx_users_email_lower_unique ja existia.';
    END;
  END IF;
END $$;

COMMENT ON INDEX IF EXISTS idx_users_email_lower_unique IS
  'W6-pass182: UNIQUE LOWER(email) anti case-conflict + app-level transform defense in depth.';
