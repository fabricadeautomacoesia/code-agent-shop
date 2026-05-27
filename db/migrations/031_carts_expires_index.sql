-- WORKER 14 pass 3: indice parcial em carts.expires_at para cleanup cron.
--
-- Audit revelou Seq Scan em:
--   SELECT id FROM carts WHERE expires_at < NOW() - INTERVAL '7 days'
-- (usado em abandon cart cleanup cron / metrics).
--
-- Em prod com 100k+ carrinhos abandonados (acumulam ao longo do tempo),
-- full scan a cada execucao = CPU dump constante.
--
-- Indice parcial (WHERE expires_at IS NOT NULL) eh micro em disco - apenas
-- carrinhos com expiracao explicita (carts orfaos persistem ate cleanup).
--
-- Idempotente: CREATE INDEX IF NOT EXISTS.

CREATE INDEX IF NOT EXISTS idx_carts_expires_cleanup
  ON carts (expires_at)
  WHERE expires_at IS NOT NULL;

ANALYZE carts;
