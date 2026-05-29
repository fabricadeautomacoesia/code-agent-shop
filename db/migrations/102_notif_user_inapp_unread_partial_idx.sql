-- Migration 102: idx_notif_user_inapp_unread PARTIAL (NotificationBell hot path)
-- ============================================================================
--
-- FIX-WORKER-14 pass 486: consume cadeia notifCache (passes 467-477)
--
-- CONTEXT:
--   NotificationBell poll 30s no storefront -> GET /notifications/unread-count
--   Tambem: GET /notifications/me?unread_only=true (inbox filter unread)
--
--   Hot queries:
--     SELECT COUNT(*) FROM notifications
--      WHERE user_id = $1 AND channel = 'in_app' AND is_read = FALSE
--     (linhas 498-501 e 505-509 notification-svc/server.js)
--
--     SELECT n.* FROM notifications n
--      WHERE n.user_id = $1 AND n.channel = 'in_app' AND is_read = FALSE
--      ORDER BY created_at DESC, id DESC
--      LIMIT 20
--
-- PRE-FIX (cadeia regression historica):
--   - mig 008: idx_notif_user_unread PARTIAL (user_id, created_at DESC) WHERE is_read=FALSE
--   - mig 029 (W14 pass 2): DROPPED idx_notif_user_unread (raciocinio incorreto:
--     'idx_notif_user_channel_created cobre' - MAS este nao e PARTIAL,
--     entao p/ users com 100+ notifs lidas, planner le tudo e Heap Filter is_read=FALSE)
--   - mig 059: idx_notif_user_channel_created (user_id, channel, created_at DESC)
--     - Cobre /me default (sem unread filter) bem
--     - Mas /me?unread_only=true e /unread-count sofrem Heap Filter
--   - Em prod com user normal (50 notifs lidas + 5 unread):
--     - planner le 55 rows via idx -> Filter -> COUNT=5
--     - Aceitavel. MAS em user spam-target (500 notifs / 1 unread):
--     - planner le 500 rows -> Filter -> COUNT=1
--     - NotificationBell poll 30s = 500 rows/poll = waste IO 1000+ users
--
-- POST-FIX:
--   idx_notif_user_inapp_unread PARTIAL composite:
--     ON notifications (user_id, created_at DESC)
--     WHERE channel = 'in_app' AND is_read = FALSE
--
--   PG planner:
--   - /unread-count: Index Scan (count only via idx) - ultra rapido
--   - /me?unread_only=true: Direct Index Scan pre-sorted - sem Sort node
--   - Predicate matching: channel='in_app' literal + is_read=FALSE literal (immutable)
--   - Idx physical size pequeno (so unread rows in_app - usually < 5% total)
--
--   Tradeoff: + 1 idx writes per INSERT notification in_app unread.
--   Aceitavel: WRITE cost barato (small idx), READ benefit 30s poll x milhares users.
--
-- COVERAGE QUERIES:
--   - GET /notifications/unread-count (NotificationBell badge poll 30s)
--   - GET /notifications/me?unread_only=true (inbox filter)
--   - POST /notifications/:id/read returning unread_count_remaining (linhas 497, 505)
--
-- PATTERN V8 W14 paridade pass 481 (pwreset PARTIAL used_at IS NULL):
--   PARTIAL com predicates immutable (channel literal + boolean)
--   Tradeoff aceito: tabela ALTA escrita mas idx hot ainda menor que full
--
-- RACIONAL VS MIG 029 DROP:
--   Pass 029 dropou idx_notif_user_unread argumentando que
--   idx_notif_user_channel_created cobre. MAS este idx nao e partial -> Heap
--   Filter post-scan. Em volumes pequenos OK, em volumes altos = waste.
--   Esta mig RECRIA versao melhorada (+ channel='in_app' no predicate cobrindo
--   gap original do mig 008 que matchava unread cross-channel).
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_notif_user_inapp_unread;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_notif_user_inapp_unread
    ON notifications(user_id, created_at DESC)
    WHERE channel = 'in_app' AND is_read = FALSE;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_notif_user_inapp_unread create: % - %', SQLSTATE, SQLERRM;
END $$;

ANALYZE notifications;

DO $$ BEGIN
  RAISE NOTICE 'W14-pass486: idx_notif_user_inapp_unread PARTIAL (NotificationBell 30s poll hot path)';
END $$;
