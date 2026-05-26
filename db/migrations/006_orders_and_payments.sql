-- ============================================================
-- 006_orders_and_payments.sql
-- Carrinho, pedidos, pagamentos Asaas, split, webhooks
-- ============================================================

-- ------------------------------------------------------------
-- CARTS: carrinho persistente (1 por user ativo)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS carts (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    session_id              VARCHAR(64),                 -- carrinho anonimo
    items_count             INT NOT NULL DEFAULT 0,
    subtotal_cents          BIGINT NOT NULL DEFAULT 0,
    coupon_code             VARCHAR(40),
    discount_cents          BIGINT NOT NULL DEFAULT 0,
    total_cents             BIGINT NOT NULL DEFAULT 0,
    currency                VARCHAR(3) NOT NULL DEFAULT 'BRL',
    expires_at              TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT carts_user_or_session CHECK (user_id IS NOT NULL OR session_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_carts_session ON carts(session_id);

DROP TRIGGER IF EXISTS trg_carts_updated_at ON carts;
CREATE TRIGGER trg_carts_updated_at BEFORE UPDATE ON carts
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ------------------------------------------------------------
-- CART_ITEMS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cart_items (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cart_id                 UUID NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
    product_id              UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    product_version_id      UUID REFERENCES product_versions(id),
    quantity                INT NOT NULL DEFAULT 1,
    unit_price_cents        BIGINT NOT NULL,
    line_total_cents        BIGINT NOT NULL,
    snapshot                JSONB,                       -- copia do produto no momento (titulo/preco)
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT cart_qty_chk CHECK (quantity > 0),
    UNIQUE(cart_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_citems_cart ON cart_items(cart_id);
CREATE INDEX IF NOT EXISTS idx_citems_product ON cart_items(product_id);

-- ------------------------------------------------------------
-- ORDERS: pedido criado a partir do carrinho
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_number            VARCHAR(20) NOT NULL UNIQUE, -- ex: CAS-2026-000001
    buyer_user_id           UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    status                  order_status NOT NULL DEFAULT 'cart',

    -- Valores
    subtotal_cents          BIGINT NOT NULL,
    discount_cents          BIGINT NOT NULL DEFAULT 0,
    coupon_code             VARCHAR(40),
    fees_cents              BIGINT NOT NULL DEFAULT 0,
    total_cents             BIGINT NOT NULL,
    currency                VARCHAR(3) NOT NULL DEFAULT 'BRL',

    -- Pagamento
    payment_method          payment_method,
    payment_status          payment_status NOT NULL DEFAULT 'pending',
    asaas_payment_id        VARCHAR(60),
    asaas_invoice_url       TEXT,
    asaas_pix_qrcode        TEXT,
    asaas_pix_copy_paste    TEXT,
    asaas_boleto_url        TEXT,

    -- Metadados
    buyer_ip                INET,
    buyer_user_agent        TEXT,
    notes                   TEXT,
    metadata                JSONB NOT NULL DEFAULT '{}'::JSONB,

    -- Timeline
    paid_at                 TIMESTAMPTZ,
    fulfilled_at            TIMESTAMPTZ,
    refunded_at             TIMESTAMPTZ,
    cancelled_at            TIMESTAMPTZ,
    expires_at              TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT orders_total_chk CHECK (total_cents >= 0),
    CONSTRAINT orders_subtotal_chk CHECK (subtotal_cents >= 0)
);

CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON orders(payment_status);
CREATE INDEX IF NOT EXISTS idx_orders_asaas ON orders(asaas_payment_id);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_paid ON orders(paid_at DESC) WHERE paid_at IS NOT NULL;

DROP TRIGGER IF EXISTS trg_orders_updated_at ON orders;
CREATE TRIGGER trg_orders_updated_at BEFORE UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

COMMENT ON TABLE orders IS 'Pedido master. order_number gerado por sequence + ano. Asaas paga split nativo.';

-- Sequence para order_number
CREATE SEQUENCE IF NOT EXISTS order_number_seq START 1;

CREATE OR REPLACE FUNCTION fn_generate_order_number()
RETURNS TEXT AS $$
DECLARE
    n BIGINT;
BEGIN
    n := nextval('order_number_seq');
    RETURN 'CAS-' || TO_CHAR(NOW(), 'YYYY') || '-' || LPAD(n::TEXT, 6, '0');
END;
$$ LANGUAGE plpgsql;

-- ------------------------------------------------------------
-- ORDER_ITEMS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_items (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id                UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id              UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    product_version_id      UUID REFERENCES product_versions(id),
    seller_id               UUID REFERENCES sellers(id) ON DELETE RESTRICT, -- NULL se platform_owned
    is_platform_owned       BOOLEAN NOT NULL DEFAULT FALSE,
    quantity                INT NOT NULL DEFAULT 1,
    unit_price_cents        BIGINT NOT NULL,
    line_total_cents        BIGINT NOT NULL,
    commission_rate         NUMERIC(5,4) NOT NULL,       -- take rate aplicado neste item
    commission_cents        BIGINT NOT NULL,             -- valor retido pela plataforma
    seller_payout_cents     BIGINT NOT NULL,             -- valor a repassar ao seller
    license_key             TEXT,                        -- chave gerada pos-pagamento
    download_token          UUID,                        -- token unico de download
    download_expires_at     TIMESTAMPTZ,
    download_count          INT NOT NULL DEFAULT 0,
    snapshot                JSONB,                       -- snapshot completo do produto
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT oi_amounts_chk CHECK (line_total_cents = commission_cents + seller_payout_cents OR is_platform_owned = TRUE)
);

CREATE INDEX IF NOT EXISTS idx_oi_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_oi_product ON order_items(product_id);
CREATE INDEX IF NOT EXISTS idx_oi_seller ON order_items(seller_id);
CREATE INDEX IF NOT EXISTS idx_oi_download_token ON order_items(download_token);

COMMENT ON TABLE order_items IS 'Linha do pedido. commission_cents + seller_payout_cents = line_total_cents (salvo platform_owned).';

-- ------------------------------------------------------------
-- ASAAS_SPLITS: detalhamento dos splits enviados ao Asaas
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS asaas_splits (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id                UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    order_item_id           UUID REFERENCES order_items(id) ON DELETE CASCADE,
    seller_id               UUID REFERENCES sellers(id),
    wallet_id               VARCHAR(60) NOT NULL,        -- wallet_id Asaas do destino
    percentage              NUMERIC(5,4),                -- alternativo a fixedValue
    fixed_value_cents       BIGINT,
    status                  VARCHAR(30) NOT NULL DEFAULT 'pending',
    asaas_split_id          VARCHAR(60),
    processed_at            TIMESTAMPTZ,
    metadata                JSONB DEFAULT '{}'::JSONB,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_splits_order ON asaas_splits(order_id);
CREATE INDEX IF NOT EXISTS idx_splits_seller ON asaas_splits(seller_id);

COMMENT ON TABLE asaas_splits IS 'Split nativo Asaas. percentage OU fixed_value_cents.';

-- ------------------------------------------------------------
-- ASAAS_WEBHOOK_EVENTS: log de webhooks recebidos do Asaas
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS asaas_webhook_events (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type              VARCHAR(80) NOT NULL,        -- PAYMENT_RECEIVED, PAYMENT_REFUNDED, etc
    asaas_event_id          VARCHAR(60) UNIQUE,
    asaas_payment_id        VARCHAR(60),
    order_id                UUID REFERENCES orders(id) ON DELETE SET NULL,
    payload                 JSONB NOT NULL,
    signature_valid         BOOLEAN,
    processed_at            TIMESTAMPTZ,
    processing_error        TEXT,
    retry_count             INT NOT NULL DEFAULT 0,
    received_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_asaas_evt_type ON asaas_webhook_events(event_type);
CREATE INDEX IF NOT EXISTS idx_asaas_evt_payment ON asaas_webhook_events(asaas_payment_id);
CREATE INDEX IF NOT EXISTS idx_asaas_evt_processed ON asaas_webhook_events(processed_at) WHERE processed_at IS NULL;

COMMENT ON TABLE asaas_webhook_events IS 'Inbox idempotente. asaas_event_id evita reprocessamento.';

-- ------------------------------------------------------------
-- COUPONS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS coupons (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code                    VARCHAR(40) NOT NULL UNIQUE,
    description             TEXT,
    discount_type           VARCHAR(15) NOT NULL,        -- 'percentage' | 'fixed'
    discount_value          NUMERIC(10,2) NOT NULL,
    max_uses                INT,
    used_count              INT NOT NULL DEFAULT 0,
    max_uses_per_user       INT,
    min_purchase_cents      BIGINT,
    applies_to              VARCHAR(20) NOT NULL DEFAULT 'all', -- 'all'|'category'|'product'|'seller'
    target_id               UUID,
    starts_at               TIMESTAMPTZ,
    expires_at              TIMESTAMPTZ,
    is_active               BOOLEAN NOT NULL DEFAULT TRUE,
    created_by              UUID REFERENCES users(id),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_coupons_active ON coupons(is_active, expires_at);
CREATE INDEX IF NOT EXISTS idx_coupons_target ON coupons(applies_to, target_id);

-- ------------------------------------------------------------
-- COUPON_USES: log de uso
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS coupon_uses (
    id                      BIGSERIAL PRIMARY KEY,
    coupon_id               UUID NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    order_id                UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    discount_applied_cents  BIGINT NOT NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cuses_coupon ON coupon_uses(coupon_id);
CREATE INDEX IF NOT EXISTS idx_cuses_user ON coupon_uses(user_id);
