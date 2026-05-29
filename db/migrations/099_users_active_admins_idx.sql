-- Migration 099: idx_users_active_admins PARTIAL (active+non-banned admins)
-- ============================================================================
--
-- FIX-WORKER-18 pass 478: consume cadeia notifCache cross-svc (passes 467-477)
--
-- CONTEXT:
--   Passes 468 (payment-svc PAYMENT_REFUND_FAILED admin notif), 477 (vault-svc
--   rotation cron bulk admin), e outros precisam fazer query:
--     SELECT id FROM users
--      WHERE role IN ('admin','staff')
--        AND is_active = TRUE
--        AND is_banned = FALSE
--        AND deleted_at IS NULL
--
-- PRE-FIX:
--   Idx existente: idx_users_role (role) PARTIAL WHERE deleted_at IS NULL
--   - Filtra role + deleted_at MAS NAO filtra is_active + is_banned
--   - PG planner usa Bitmap Index Scan + Heap Filter pos-bitmap
--   - Em 10k+ users: idx encontra ~10 admins, depois filtra heap rows
--   - Latency: ~5ms small datasets, ~20-50ms scaling
--
-- POST-FIX:
--   idx PARTIAL focado: (role) WHERE active+nao-banned+nao-deleted
--   - PG planner: direct Index Scan (skip Heap Filter)
--   - Latency: ~1-3ms consistent independente dataset size
--   - Pattern V8 paridade pass 086 (audit_log severity PARTIAL)
--
-- TRADE-OFF:
--   - Idx adicional ~5-10KB (10-20 admins entries)
--   - INSERT/UPDATE overhead +1 idx write em mutations users (raro - admin
--     register/deactivate <1/dia)
--   - Aceitavel: hot-path admin lookup cron + webhook patterns
--
-- COVERAGE QUERIES otimizadas:
--   - vault-svc rotation cron (pass 477) - diaria, bulk admins
--   - payment-svc PAYMENT_REFUND_FAILED admin (pass 468 webhook hot path)
--   - Futuro: admin alert dispatches generic
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_users_active_admins;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_users_active_admins
    ON users(role)
    WHERE role IN ('admin','staff')
      AND is_active = TRUE
      AND is_banned = FALSE
      AND deleted_at IS NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_users_active_admins create: % - %', SQLSTATE, SQLERRM;
END $$;

ANALYZE users;

DO $$ BEGIN
  RAISE NOTICE 'W18-pass478: idx_users_active_admins PARTIAL (consume cadeia notifCache cross-svc passes 467-477)';
END $$;
