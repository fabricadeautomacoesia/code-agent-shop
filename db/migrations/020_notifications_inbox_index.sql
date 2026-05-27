-- Migration 020: Indice para bandeja in-app notifications (WORKER 18 perf)
-- =====================================================================
-- PROBLEMA:
-- pg_stat_user_tables mostrou notifications com 1662 seq_scan vs 358 idx_scan
-- (4051 tup_read seq) - liderando a tabela mais varrida do sistema.
--
-- Query alvo (services/notification-svc/server.js:78 - bandeja in-app):
--   SELECT * FROM notifications
--    WHERE user_id = $1 AND channel = 'in_app'
--    ORDER BY created_at DESC LIMIT 30
--
-- Indices existentes nao cobrem esse access pattern:
--   - idx_notif_user_unread (user_id, created_at DESC) WHERE is_read = false
--     -> ignorado pois query lista TUDO (lidas + nao-lidas)
--   - idx_notif_pending / idx_notif_outbox_ready -> sao pra outbox/cron
--
-- SOLUCAO:
-- Composite (user_id, channel, created_at DESC) cobre exatamente os filtros
-- + ORDER BY. Sem WHERE parcial pois precisa servir TODAS as notificacoes
-- in_app do user (lidas/nao-lidas, sucesso/falhou, etc).
-- =====================================================================
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_notif_user_channel_created
    ON notifications(user_id, channel, created_at DESC);
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

-- =====================================================================
-- BONUS: notification-svc/server.js:175 join com sellers/users
-- usa user_id ainda sem channel. Indice anterior idx_notif_user_unread
-- (parcial) ja cobre quando is_read=false. Para a contagem total/listagem
-- por user (sem filtro channel), o novo composite ja serve via left-anchored
-- column user_id - postgres usa leftmost prefix.
-- Nada novo necessario aqui.
-- =====================================================================
