-- Migration 124: idx_notif_user_channel_created_id direction parity DESC+DESC tiebreaker
-- ============================================================================
--
-- FIX-WORKER-14 pass 638: consume notification-svc GET / inbox ORDER BY
-- tiebreaker direction parity. Paridade Regra D V8 cross-svc (cadeia mig 102-123).
--
-- CONTEXT:
--   notification-svc GET / (server.js linha 396-415):
--     SELECT n.id, n.channel, n.template_code, n.title, n.body, ...
--            COUNT(*) OVER()::INT AS _total
--       FROM notifications n
--       LEFT JOIN user_notification_prefs unp ON ...
--      WHERE n.user_id = $1 AND n.channel = 'in_app' [unread_only filter]
--        AND (unp.is_enabled IS NULL OR unp.is_enabled = TRUE OR ...)
--      ORDER BY n.created_at DESC, n.id DESC
--      LIMIT $2 OFFSET $3
--
--   HOT PATH: NotificationBell polling 30s + multi-tab amplification.
--   /conta/notificacoes page also polls + initial bell load.
--
-- PRE-FIX existing index (mig 020):
--   idx_notif_user_channel_created ON notifications(user_id, channel, created_at DESC)
--   - Covers WHERE user_id + channel='in_app' + ORDER BY created_at DESC
--   - MAS NAO inclui id DESC tiebreaker
--   - Cron mass-import notif (broadcast event - admin warning) - 100+ rows
--     mesmo created_at second-precision -> tiebreaker id DESC External Sort
--   - notifications table grows ~50-200 rows/day em prod = ~100k+ rows/year
--   - External Sort overhead per query ~3-8ms
--   - Multi-tab polling 30s = N queries simultaneas amplifica
--
-- POST-FIX:
--   idx_notif_user_channel_created_id composite direction parity Regra D V8:
--     ON notifications (user_id, channel, created_at DESC, id DESC)
--
--   Planner steps:
--   1. Direct Index Scan idx_notif_user_channel_created_id WHERE user_id+channel
--      (pre-sorted full ORDER BY descending tiebreaker)
--   2. LEFT JOIN user_notification_prefs via PK lookup
--   3. LIMIT N + OFFSET M (SEM External Sort)
--
--   Latency: ~3-8ms External Sort eliminado -> ~1-2ms total query
--   Storage: ~5-10MB para 100k notifs prod
--
--   Trade-off vs mig 020 idx_notif_user_channel_created:
--   - mig 020 cobre simple WHERE+ORDER (sem tiebreaker)
--   - mig 124 (este) cobre GET / ORDER tiebreaker completo direction parity
--   - Manter ambos. pg_stat_user_indexes decision drop futuro
--
-- COVERAGE QUERIES:
--   - GET / (este path - NotificationBell polling + /conta/notificacoes)
--   - Future cron notif_export forensic reports
--
-- PATTERN V8 W14 cadeia direction parity composite tiebreaker:
--   passes 102-123 (22 indexes consolidacao previa)
--   pass 124 (este) notif_user_channel direction parity DESC+DESC
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_notif_user_channel_created_id;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_notif_user_channel_created_id
    ON notifications (user_id, channel, created_at DESC, id DESC);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_notif_user_channel_created_id create: % - %', SQLSTATE, SQLERRM;
END $$;

ANALYZE notifications;

DO $$ BEGIN
  RAISE NOTICE 'W14-pass638: idx_notif_user_channel_created_id direction parity DESC+DESC tiebreaker NotificationBell hot path (paridade Regra D cadeia mig 102-123)';
END $$;
