-- Migration 014: Loyalty redeem (WORKER 16 - extensao do MLB-4)
-- Adiciona colunas no cart para rastrear pontos resgatados como desconto.
-- Politica: 100 pontos = R$1 (1 cent por ponto). Min 500 pts (R$5). Cap 30% subtotal.

DO $$ BEGIN
  ALTER TABLE carts ADD COLUMN loyalty_points_redeemed INT NOT NULL DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN NULL; WHEN undefined_table THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE carts ADD COLUMN loyalty_discount_cents BIGINT NOT NULL DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN NULL; WHEN undefined_table THEN NULL; END $$;

-- Mesmas colunas em orders para preservar historico
DO $$ BEGIN
  ALTER TABLE orders ADD COLUMN loyalty_points_redeemed INT NOT NULL DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN NULL; WHEN undefined_table THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE orders ADD COLUMN loyalty_discount_cents BIGINT NOT NULL DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN NULL; WHEN undefined_table THEN NULL; END $$;

DO $$ BEGIN
  INSERT INTO schema_migrations (version, applied_at)
  VALUES ('014_loyalty_redeem', NOW())
  ON CONFLICT (version) DO NOTHING;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;
