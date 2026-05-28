-- Migration 069: indice token_hash em password_resets (W18 pass 233)
-- 2026-05-28
--
-- CONTEXTO:
-- /auth/reset-password (auth.js:786) executa:
--   SELECT id, user_id FROM password_resets
--    WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
--    FOR UPDATE
--
-- password_resets ja tem (mig 002):
--   - idx_pwreset_user (user_id)        -- usado em /forgot-password cleanup
--   - idx_pwreset_expires (expires_at)  -- usado em retention cron cleanup
--
-- MAS NAO tem indice em token_hash - coluna mais filtrada (WHERE primary).
-- Resultado: FULL TABLE SCAN + FOR UPDATE em CADA reset attempt.
--
-- IMPACTO (prod com retention 90d):
-- - ~10 password_resets/dia x 90d = 900 rows ativas
-- - Cada reset attempt scan 900 rows + FOR UPDATE row-lock (todas rows!)
-- - Concurrent /reset-password aguarda FOR UPDATE de outras (queue serial)
-- - Latency: 5-30ms (escala linear com row count)
--
-- POST-FIX:
-- - Index B-tree em token_hash (single column, UNIQUE bonus anti-collision)
-- - Lookup O(log n) em vez O(n)
-- - FOR UPDATE acquire lock APENAS na row matched
-- - Concurrent /reset-password independentes (different tokens) paralelos
--
-- ROLLBACK: DROP INDEX IF EXISTS idx_pwreset_token_hash;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pwreset_token_hash
  ON password_resets(token_hash);

DO $$
BEGIN
  RAISE NOTICE 'W18-pass233: idx_pwreset_token_hash created (UNIQUE - anti collision + fast lookup)';
END $$;
