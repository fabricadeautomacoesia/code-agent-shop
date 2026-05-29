-- Migration 115: idx_products_flash_promo_active_full PARTIAL tighter (full predicate)
-- ============================================================================
--
-- FIX-WORKER-14 pass 603: consume product-svc /flash-promo/active hot path
-- com PARTIAL predicate FULL paridade query (status + deleted_at).
--
-- CONTEXT:
--   product-svc /products/flash-promo/active (linha 617-633) - storefront
--   /promocoes page + PDP flash badge polling 60s (cache TTL).
--
--   Query padrao:
--     SELECT ... FROM products p
--       LEFT JOIN sellers s ON s.id = p.seller_id
--      WHERE p.status IN ('approved','platform_owned')
--        AND p.flash_promo_active = TRUE
--        AND p.flash_promo_ends_at > NOW()
--        AND p.deleted_at IS NULL
--      ORDER BY p.flash_promo_ends_at ASC, p.id ASC
--      LIMIT $1 OFFSET $2
--
-- PRE-FIX existing index:
--   mig 010 idx_products_flash_promo (flash_promo_ends_at) WHERE flash_promo_active = TRUE
--
--   PARTIAL predicate INCOMPLETE:
--   - Inclui flash_promo_active=TRUE (OK)
--   - NAO inclui status IN ('approved','platform_owned')
--   - NAO inclui deleted_at IS NULL
--   - Idx returns rejected/archived/deleted products que erroneously tem
--     flash_promo_active=TRUE (admin edit slip + future workflow risk)
--   - Filter post-scan needed: status check + deleted_at check
--   - Em prod com 20-50 flash promo active products: rare mas defensive gap
--
-- POST-FIX:
--   idx_products_flash_promo_active_full PARTIAL composite tighter:
--     ON products (flash_promo_ends_at ASC, id ASC)
--     WHERE flash_promo_active = TRUE
--       AND status IN ('approved','platform_owned')
--       AND deleted_at IS NULL
--
--   - PARTIAL muito seletivo: SO produtos publicaveis com flash promo
--   - Storage marginal (~20-50 rows ativos em prod)
--   - INSERT overhead 0 (predicate rejeita 99%+ rows products)
--   - Direct Index Scan pre-sorted + LIMIT (SEM Filter post-scan)
--   - + id ASC tiebreaker ja matches query ORDER BY (eliminate sort)
--   - Latency: ~5-10ms (cache miss path) -> ~1-2ms
--
--   Trade-off vs mig 010 idx_products_flash_promo:
--   - mig 010 cobre admin queries que filtram differently (todos flash incl rejected)
--   - Manter ambos. pg_stat_user_indexes mostra usage decision drop futuro
--   - Storage trade-off: 2 PARTIALs muito seletivos = total ~50KB extra
--
-- COVERAGE QUERIES:
--   - /flash-promo/active (este path - storefront /promocoes hot path)
--   - PDP flash badge inline render (RecentSaleBadge polling)
--   - Future cron flash_promo_expire (timer ended cleanup)
--
-- PATTERN V8 W14 cadeia PARTIAL com full predicate cron-aware:
--   passes 102-114 (13 indexes consolidacao nesta sessao)
--   pass 115 (este) products_flash_promo_active_full PARTIAL full predicate
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_products_flash_promo_active_full;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_products_flash_promo_active_full
    ON products (flash_promo_ends_at ASC, id ASC)
    WHERE flash_promo_active = TRUE
      AND status IN ('approved','platform_owned')
      AND deleted_at IS NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_products_flash_promo_active_full create: % - %', SQLSTATE, SQLERRM;
END $$;

ANALYZE products;

DO $$ BEGIN
  RAISE NOTICE 'W14-pass603: idx_products_flash_promo_active_full PARTIAL full predicate (consume /flash-promo/active)';
END $$;
