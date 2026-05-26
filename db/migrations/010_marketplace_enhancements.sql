-- ============================================================
-- 010_marketplace_enhancements.sql
-- W14: Colunas/indices uteis identificados em uso real
-- Tolerante a falhas (IF NOT EXISTS + DO $$ EXCEPTION $$)
-- ============================================================

-- product_qna_votes - criada manualmente, garantir
CREATE TABLE IF NOT EXISTS product_qna_votes (
    qna_id      UUID NOT NULL REFERENCES product_qna(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(qna_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_qna_votes_qna ON product_qna_votes(qna_id);

-- Promocao relampago (MLB-10)
DO $$ BEGIN
    ALTER TABLE products ADD COLUMN flash_promo_active BOOLEAN DEFAULT FALSE;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE products ADD COLUMN flash_promo_discount_pct NUMERIC(5,2);
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE products ADD COLUMN flash_promo_ends_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- Indice para promocoes ativas
CREATE INDEX IF NOT EXISTS idx_products_flash_promo
    ON products(flash_promo_ends_at)
    WHERE flash_promo_active = TRUE;

-- Coluna para "ultima venda" - usado em "Vendido X vezes nas ultimas 24h"
DO $$ BEGIN
    ALTER TABLE products ADD COLUMN last_sale_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- Indice para listings por categoria + sales_count (otimiza top-sellers)
CREATE INDEX IF NOT EXISTS idx_products_cat_sales
    ON products(category_id, sales_count DESC)
    WHERE status = 'approved' AND deleted_at IS NULL;

-- Indice para wishlist count (recomendacoes)
CREATE INDEX IF NOT EXISTS idx_wishlist_product ON product_wishlist(product_id);

-- Coupon progressivo (MLB-11)
DO $$ BEGIN
    ALTER TABLE coupons ADD COLUMN tier_breakpoints JSONB;
    -- ex: [{"qty":2,"discount_pct":10},{"qty":3,"discount_pct":20}]
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- Loyalty/Pontos (MLB-3)
CREATE TABLE IF NOT EXISTS user_loyalty (
    user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    points_balance   BIGINT NOT NULL DEFAULT 0,
    points_lifetime  BIGINT NOT NULL DEFAULT 0,
    tier             VARCHAR(20) NOT NULL DEFAULT 'starter',  -- starter, gold, platinum
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS loyalty_transactions (
    id               BIGSERIAL PRIMARY KEY,
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    points_delta     INT NOT NULL,  -- positivo = ganho, negativo = uso
    reason           VARCHAR(60) NOT NULL,
    reference_type   VARCHAR(30),
    reference_id     UUID,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_loyalty_user ON loyalty_transactions(user_id, created_at DESC);

-- Comparador (MLB-7) - tabela temporaria de comparacoes
CREATE TABLE IF NOT EXISTS product_compare_sessions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID REFERENCES users(id) ON DELETE CASCADE,
    session_token VARCHAR(64),  -- anonimo
    product_ids   UUID[] NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at    TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days'
);
CREATE INDEX IF NOT EXISTS idx_compare_user ON product_compare_sessions(user_id);

COMMENT ON TABLE user_loyalty IS 'Saldo de pontos por user (MLB-3)';
COMMENT ON TABLE product_compare_sessions IS 'Comparador de ate 4 produtos (MLB-7)';
