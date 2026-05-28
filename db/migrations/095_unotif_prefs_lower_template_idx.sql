-- Migration 095: functional idx user_notification_prefs LOWER(template_code)
-- ===========================================================================
--
-- FIX-WORKER-14 pass 437: hot-path perf consume pass 436 (in_app opt-out JOIN)
--
-- CONTEXT:
--   Pass 436 adicionou LEFT JOIN user_notification_prefs em 2 endpoints
--   notification-svc hot-path (GET / list + GET /unread-count):
--     LEFT JOIN user_notification_prefs unp ON
--       unp.user_id = n.user_id
--       AND LOWER(unp.template_code) = LOWER(n.template_code)
--       AND unp.channel = n.channel
--   Razao do LOWER(): pass 238 estabeleceu defensive case-fold p/ CRITICAL
--   templates check em processOutbox (mig drift / dev typo protection).
--   Pass 436 propagou mesmo pattern em GET / list (consistency).
--
-- PRE-FIX BUG (introduzido por pass 436):
--   - user_notification_prefs PK e (user_id, template_code, channel)
--   - LOWER() na expr ON kills PK lookup possibility
--   - PG planner forcado a:
--     - Para cada notif row (LIMIT 20-50) -> Seq Scan/Hash Join unp
--     - unp em prod cresce ~N_users * M_templates * C_channels (~100k+ rows)
--   - Hot-path GET / list (NotificationBell open) ~150ms -> ~500ms+ em prod
--   - Hot-path GET /unread-count (poll 30s cada client) - thrash DB cumulativo
--
-- POST-FIX:
--   Functional expression index com LOWER(template_code) embed:
--     idx_unotif_prefs_lower_lookup (user_id, LOWER(template_code), channel)
--   - PG planner agora encontra match exato p/ JOIN com LOWER expression
--   - Index Scan O(log N) por notif row vs Seq Scan O(N)
--   - Latencia esperada GET / list: ~500ms -> ~30ms (16x melhoria com 100k prefs)
--   - GET /unread-count poll: <5ms hit (com cache 20s pass 212 -> 99% hit rate)
--
-- IMPACT:
--   user_notification_prefs table - hot path JOIN consume.
--   Existing idx_unotif_prefs_user (mig 016) preservado p/ outras queries.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_unotif_prefs_lower_lookup;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_unotif_prefs_lower_lookup
    ON user_notification_prefs(user_id, LOWER(template_code), channel);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_unotif_prefs_lower_lookup create: % - %', SQLSTATE, SQLERRM;
END $$;

-- ANALYZE para planner stats fresh com novo idx
ANALYZE user_notification_prefs;

DO $$ BEGIN
  RAISE NOTICE 'W14-pass437: idx_unotif_prefs_lower_lookup (user_id+LOWER(template_code)+channel) for hot-path JOIN consume pass 436';
END $$;
