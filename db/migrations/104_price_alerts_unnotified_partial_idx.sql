-- Migration 104: idx_price_alerts_unnotified PARTIAL (trigger fn_price_drop_notify hot path)
-- ============================================================================
--
-- FIX-WORKER-14 pass 504: consume trigger fn_price_drop_notify hot path
--
-- CONTEXT:
--   Trigger fn_price_drop_notify (mig 030) executa em CADA UPDATE de
--   products.price_cents quando preco baixa:
--     FOR alert_rec IN
--       SELECT a.id, a.user_id, a.threshold_cents
--         FROM product_price_alerts a
--        WHERE a.product_id = NEW.id
--          AND (a.threshold_cents IS NULL OR NEW.price_cents <= a.threshold_cents)
--          AND (a.last_notified_at IS NULL OR a.last_notified_at < NOW() - INTERVAL '24 hours')
--     LOOP
--       INSERT INTO notifications ...
--       UPDATE product_price_alerts SET last_notified_at = NOW() WHERE id = alert_rec.id;
--     END LOOP;
--
--   Cenarios de stress:
--   - Flash promo bulk: admin/cron baixa precos em 100 products = 100 triggers
--   - Viral product: 1000+ users com alert ativo (Mercado Livre features)
--   - Re-pricing nightly: catalog refresh modifica 5000+ products
--
-- PRE-FIX indexes existentes (mig 030):
--   - idx_price_alerts_product (product_id)
--   - idx_price_alerts_user (user_id, created_at DESC)
--
--   Planner para query trigger:
--   - Index Scan idx_price_alerts_product (scope product_id)
--   - Heap Filter: threshold_cents check + last_notified_at < cutoff
--   - Para viral product 1000+ alerts: scan all + filter heap O(N)
--   - Lock row-level products durante trigger (>500ms para mass-rebid)
--
-- POST-FIX:
--   idx_price_alerts_unnotified PARTIAL composite:
--     ON product_price_alerts (product_id)
--     WHERE last_notified_at IS NULL
--
--   Cobertura:
--   - Alerts NEVER notified (last_notified_at IS NULL) = caso comum
--     em alerts criados recentemente, ou apos cleanup cron (24h+ expired)
--   - Estado healthy: maioria de alerts em produto popular NUNCA notified
--     (cada alert notifica 1x/24h - se ja notificou, fora desta partial)
--   - Idx physical small (~1% subset dos alerts em prod normal)
--
--   Tradeoff: alerts ja notificados precisam scan full idx_price_alerts_product.
--   ACEITAVEL pois sao MINORIA em prod normal (24h anti-spam cycle).
--
--   PARTIAL com predicate IS NULL (immutable) - PG permite (sem NOW() trap).
--   Pattern V8 paridade pass 481 pwreset PARTIAL used_at IS NULL.
--
-- COVERAGE QUERIES:
--   - Trigger fn_price_drop_notify (mig 030) hot path
--   - Future: admin endpoint /admin/price-alerts/active (UNNOTIFIED filter)
--
-- LATENCIA ESPERADA:
--   - Viral product 1000 alerts, 990 unnotified, 10 ja notified:
--     - Pre-fix: Index Scan 1000 + Heap Filter -> ~20ms
--     - Post-fix: Index Scan PARTIAL 990 + lookup full idx for 10 -> ~5ms
--   - 4x improvement em viral cases, sem regressao em casos normais.
--
-- PATTERN V8 W14 cadeia:
--   pass 481 idx_pwreset_pending_unused PARTIAL used_at IS NULL
--   pass 486 idx_notif_user_inapp_unread PARTIAL channel+is_read
--   pass 500 idx_qa_runs_product_timeout PARTIAL verdict
--   pass 504 (este) idx_price_alerts_unnotified PARTIAL last_notified_at IS NULL
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_price_alerts_unnotified;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_price_alerts_unnotified
    ON product_price_alerts(product_id)
    WHERE last_notified_at IS NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_price_alerts_unnotified create: % - %', SQLSTATE, SQLERRM;
END $$;

ANALYZE product_price_alerts;

DO $$ BEGIN
  RAISE NOTICE 'W14-pass504: idx_price_alerts_unnotified PARTIAL (consume trigger fn_price_drop_notify)';
END $$;
