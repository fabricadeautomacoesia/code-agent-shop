-- Migration 055: ADD idx composite p/ active sessions query (W14 pass 143)
--
-- Análise:
-- - UI /conta/seguranca lista sessoes ativas do usuario:
--     WHERE user_id = $1 AND is_revoked = false AND expires_at > NOW()
--     ORDER BY last_seen_at DESC NULLS LAST LIMIT 10
-- - 5 indices existentes, nenhum cobre query composta:
--     * idx_sessions_user partial WHERE is_revoked=false (so user_id)
--     * idx_sessions_expires (so expires_at)
--     * idx_sessions_revoked (so is_revoked)
-- - Query atual faz Index Scan idx_sessions_user + Filter expires_at + Sort
-- - Composite idx cobre tudo num lookup unico
--
-- Pattern: idx parcial + ORDER BY = covering scan
-- last_seen_at DESC NULLS LAST sera evaluated em-ordem do idx,
-- evitando explicit Sort em userOrder>10 sessoes.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_sessions_user_active;

CREATE INDEX IF NOT EXISTS idx_sessions_user_active
  ON user_sessions (user_id, last_seen_at DESC NULLS LAST)
  WHERE is_revoked = false;

ANALYZE user_sessions;
