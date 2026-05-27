-- Migration 017: Cupom segmentado por tier loyalty (WORKER 16 MLB++)
-- Mercado Livre tem "Promocoes exclusivas Mercado Pago Nivel 6". Equivalente CAS:
-- cupons que so podem ser aplicados por users em tier especifico ou superior.
-- Ex: cupom GOLD20 (-20%) so para users tier=gold ou platinum.

DO $$ BEGIN
  ALTER TABLE coupons ADD COLUMN min_tier VARCHAR(20);
  -- valores: NULL (any), 'starter', 'gold', 'platinum'
EXCEPTION WHEN duplicate_column THEN NULL; WHEN undefined_table THEN NULL; END $$;

-- Index para filtragem rapida em listings publicos de cupons (futuramente UI)
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_coupons_min_tier ON coupons(min_tier)
    WHERE is_active = TRUE AND min_tier IS NOT NULL;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

-- Seed: cupom GOLD20 exclusivo para gold+
DO $$ BEGIN
  INSERT INTO coupons (code, description, discount_type, discount_value, min_tier, is_active, starts_at, expires_at)
  VALUES (
    'GOLD20',
    'Exclusivo CAS Gold/Platinum - 20% off em qualquer compra',
    'percentage',
    20.00,
    'gold',
    TRUE,
    NOW() - INTERVAL '1 day',
    NOW() + INTERVAL '365 days'
  ) ON CONFLICT (code) DO UPDATE SET
    min_tier = EXCLUDED.min_tier,
    description = EXCLUDED.description;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

-- Seed: cupom PLATINUM50 (top tier reward)
DO $$ BEGIN
  INSERT INTO coupons (code, description, discount_type, discount_value, min_tier, is_active, starts_at, expires_at)
  VALUES (
    'PLATINUM50',
    'Exclusivo CAS Platinum - 50% off no primeiro produto premium',
    'percentage',
    50.00,
    'platinum',
    TRUE,
    NOW() - INTERVAL '1 day',
    NOW() + INTERVAL '365 days'
  ) ON CONFLICT (code) DO UPDATE SET
    min_tier = EXCLUDED.min_tier,
    description = EXCLUDED.description;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

DO $$ BEGIN
  INSERT INTO schema_migrations (version, applied_at)
  VALUES ('017_coupon_tier_segmentation', NOW())
  ON CONFLICT (version) DO NOTHING;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;
