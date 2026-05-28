-- Migration 083: idx PARTIAL notifications cleanup hot-path (cron pass 279)
-- W14 pass 290 - 2026-05-28
--
-- CONTEXTO:
-- notification-svc cron 0 4 * * * roda 2 DELETEs (pass 279):
-- (1) Regular 60d: priority<3 AND template_code NOT LIKE 'security_%'
--     AND template_code NOT LIKE 'password_%' AND template_code NOT LIKE '2fa_%'
--     AND template_code != 'asaas_refund_failed'
-- (2) Security 365d: priority>=3 OR template_code LIKE 'security_%' etc
--
-- Idx existentes:
-- - idx_notif_created (created_at DESC) - cobre ORDER BY mas range scan toda tabela
-- - idx_notif_user_unread - bypass cleanup
-- - idx_notif_outbox_ready - bypass cleanup
--
-- HOT-PATH cleanup: scan completo de notifications (>1M rows em maturidade)
-- aplicando filtros priority + template_code prefix. Cada DELETE 50000 rows
-- mas planner faz seq scan na 1a passada -> idx_notif_created ajuda apenas
-- range created_at, mas planner ainda heap-fetch p/ verificar priority+template_code.
--
-- POST-FIX: idx PARTIAL ja filtrando criteria CLEAN-ABLE em static predicate.
-- Static predicate em PG nao pode usar NOW() ou regex, so column-static comparisons.
-- Aproveitamos:
-- (1) Regular: priority < 3 + template_code NOT IN security/password/2fa
--     Static predicate: priority < 3 (filter na construcao + cleanup runs filtro
--     prefix dinamico via heap fetch reduzido).
-- (2) Security: priority >= 3 - static partial.
--
-- 2 idx separados (1 p/ cada tier de retention).
--
-- ROLLBACK: DROP INDEX IF EXISTS idx_notif_cleanup_regular, idx_notif_cleanup_security;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_notif_cleanup_regular
    ON notifications (created_at, template_code)
    WHERE priority < 3;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_notif_cleanup_security
    ON notifications (created_at)
    WHERE priority >= 3;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

ANALYZE notifications;

DO $$
BEGIN
  RAISE NOTICE 'W14-pass290: idx_notif_cleanup_regular + idx_notif_cleanup_security (PARTIAL retention)';
END $$;
