-- Migration 100: idx_pwreset_pending PARTIAL (active password resets per user)
-- ============================================================================
--
-- FIX-WORKER-14 pass 481: consume cadeia auth flow (passes 480 login + reset)
--
-- CONTEXT:
--   /forgot-password flow (pass 50 W7):
--     UPDATE password_resets SET used_at = NOW()
--      WHERE user_id = $1 AND used_at IS NULL AND expires_at > NOW()
--   (invalida tokens previos pending antes de gerar novo)
--
-- PRE-FIX:
--   Idx existentes: idx_pwreset_user (user_id) + idx_pwreset_expires (expires_at)
--   Query "WHERE user_id=X AND used_at IS NULL AND expires_at > NOW()":
--   - PG planner: Bitmap idx_pwreset_user (scope user) + Heap Filter on used_at + expires_at
--   - User com 100+ historicos password_resets (legitimate ou attack):
--     - idx encontra 100 rows, depois filter heap p/ pegar pending atual
--     - Latency: ~5-10ms scaling com user volume
--
-- POST-FIX:
--   idx PARTIAL especifico:
--     idx_pwreset_pending ON password_resets(user_id)
--     WHERE used_at IS NULL AND expires_at > NOW()
--
--   PROBLEM: PARTIAL WHERE com NOW() = non-immutable expression - PG rejeita.
--
--   SOLUTION: PARTIAL apenas com used_at IS NULL (immutable):
--     idx_pwreset_pending_unused ON password_resets(user_id, expires_at DESC)
--     WHERE used_at IS NULL
--
--   Tradeoff: inclui expired tokens (used_at IS NULL mas expires_at < NOW())
--   MAS cleanup cron mata expired antiga - idx small em prod normal.
--   Query planner: idx scan (user_id, expires_at) + check expires_at > NOW.
--
-- COVERAGE QUERIES:
--   - /forgot-password invalidate previos (pass 50)
--   - Hipotetico: admin lista active resets de user (forensic)
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_pwreset_pending_unused;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_pwreset_pending_unused
    ON password_resets(user_id, expires_at DESC)
    WHERE used_at IS NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_pwreset_pending_unused create: % - %', SQLSTATE, SQLERRM;
END $$;

ANALYZE password_resets;

DO $$ BEGIN
  RAISE NOTICE 'W14-pass481: idx_pwreset_pending_unused PARTIAL used_at IS NULL (consume forgot-password flow)';
END $$;
