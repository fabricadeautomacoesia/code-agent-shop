-- ============================================================
-- 003_sellers_and_vault.sql
-- Vendedores Classes A/B, cofre AES-256 de API keys, SLA timer
-- ============================================================

-- ------------------------------------------------------------
-- SELLERS: perfil de vendedor (extensao 1:1 de users com role=seller)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sellers (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    seller_class            seller_class NOT NULL DEFAULT 'class_a',
    status                  seller_status NOT NULL DEFAULT 'pending_kyc',
    store_slug              VARCHAR(60) NOT NULL UNIQUE,
    store_name              VARCHAR(120) NOT NULL,
    store_description       TEXT,
    store_banner_url        TEXT,
    store_logo_url          TEXT,

    -- KYC / Compliance
    document_type           VARCHAR(20),                 -- 'cpf' ou 'cnpj'
    document_number_hash    VARCHAR(255),                -- hash, nao plain
    document_verified_at    TIMESTAMPTZ,
    legal_name              VARCHAR(200),
    address_line1           VARCHAR(200),
    address_line2           VARCHAR(200),
    address_city            VARCHAR(100),
    address_state           VARCHAR(2),
    address_zip             VARCHAR(20),
    address_country         VARCHAR(2) DEFAULT 'BR',

    -- Asaas
    asaas_customer_id       VARCHAR(60),                 -- ID Asaas do seller (split destination)
    asaas_wallet_id         VARCHAR(60),                 -- wallet para receber split
    asaas_pix_key           VARCHAR(200),

    -- SLA Classe B
    sla_active              BOOLEAN NOT NULL DEFAULT FALSE,
    sla_days                INT NOT NULL DEFAULT 15,
    sla_last_upload_at      TIMESTAMPTZ,
    sla_next_deadline_at    TIMESTAMPTZ,
    sla_warning_sent_at     TIMESTAMPTZ,
    sla_revoked_count       INT NOT NULL DEFAULT 0,

    -- Configuracoes do seller
    auto_approve_qa         BOOLEAN NOT NULL DEFAULT FALSE,  -- so admin pode marcar
    allow_platform_resale   BOOLEAN NOT NULL DEFAULT TRUE,   -- clausula master
    custom_commission_rate  NUMERIC(5,4),                -- override take rate (0-1)
    payout_min_amount_cents BIGINT DEFAULT 5000,         -- minimo R$50 padrao

    -- Estatisticas (atualizadas via trigger ou worker)
    total_sales             BIGINT NOT NULL DEFAULT 0,
    total_revenue_cents     BIGINT NOT NULL DEFAULT 0,
    total_products_active   INT NOT NULL DEFAULT 0,
    avg_rating              NUMERIC(3,2),
    reputation_tier         reputation_tier NOT NULL DEFAULT 'iniciante',
    reputation_score        INT NOT NULL DEFAULT 0,

    metadata                JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at              TIMESTAMPTZ,

    CONSTRAINT sellers_slug_chk CHECK (store_slug ~ '^[a-z0-9][a-z0-9-]{2,58}[a-z0-9]$'),
    CONSTRAINT sellers_commission_chk CHECK (custom_commission_rate IS NULL OR (custom_commission_rate >= 0 AND custom_commission_rate < 1)),
    CONSTRAINT sellers_sla_days_chk CHECK (sla_days BETWEEN 1 AND 365)
);

CREATE INDEX IF NOT EXISTS idx_sellers_class ON sellers(seller_class);
CREATE INDEX IF NOT EXISTS idx_sellers_status ON sellers(status);
CREATE INDEX IF NOT EXISTS idx_sellers_sla_deadline ON sellers(sla_next_deadline_at)
    WHERE sla_active = TRUE AND status = 'active';
CREATE INDEX IF NOT EXISTS idx_sellers_reputation ON sellers(reputation_tier, reputation_score DESC);
CREATE INDEX IF NOT EXISTS idx_sellers_slug ON sellers(store_slug);
CREATE INDEX IF NOT EXISTS idx_sellers_storename_trgm ON sellers USING GIN (store_name gin_trgm_ops);

DROP TRIGGER IF EXISTS trg_sellers_updated_at ON sellers;
CREATE TRIGGER trg_sellers_updated_at BEFORE UPDATE ON sellers
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

COMMENT ON TABLE sellers IS 'Perfil de vendedor. Classe A = independente, Classe B = patrocinado Cloud Code Ilimitado.';
COMMENT ON COLUMN sellers.allow_platform_resale IS 'Clausula Master de Revenda Direta. Default TRUE conforme termos.';
COMMENT ON COLUMN sellers.custom_commission_rate IS 'NULL = usa global PLATFORM_TAKE_RATE (.env). Override apenas por admin.';
COMMENT ON COLUMN sellers.sla_next_deadline_at IS 'Cron job verifica diariamente. NOW() > deadline => status=sla_revoked + revoga API keys.';

-- ------------------------------------------------------------
-- VAULT_API_KEYS: cofre AES-256 das API keys (LLM providers, etc) para Classe B
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vault_api_keys (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    seller_id               UUID REFERENCES sellers(id) ON DELETE CASCADE,
    provider                VARCHAR(50) NOT NULL,        -- 'openai', 'anthropic', 'gemini', 'groq'
    key_alias               VARCHAR(100) NOT NULL,       -- ex: 'openai-prod-shared-001'
    encrypted_key           TEXT NOT NULL,               -- AES-256-GCM ciphertext (base64)
    iv                      BYTEA NOT NULL,              -- 16 bytes
    auth_tag                BYTEA NOT NULL,              -- GCM tag (16 bytes)
    key_fingerprint         VARCHAR(64) NOT NULL,        -- SHA-256 dos 8 primeiros chars (audit sem expor)
    monthly_quota_usd_cents BIGINT,                      -- limite mensal por seller (Classe B)
    usage_this_month_cents  BIGINT NOT NULL DEFAULT 0,
    is_platform_pool        BOOLEAN NOT NULL DEFAULT TRUE,  -- TRUE = pool da plataforma, FALSE = BYOK do seller
    is_active               BOOLEAN NOT NULL DEFAULT TRUE,
    revoked_at              TIMESTAMPTZ,
    revoked_reason          VARCHAR(200),
    last_used_at            TIMESTAMPTZ,
    last_used_ip            INET,
    rotation_due_at         TIMESTAMPTZ,                 -- rotacao periodica
    expires_at              TIMESTAMPTZ,
    metadata                JSONB DEFAULT '{}'::JSONB,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT vault_provider_chk CHECK (provider IN ('openai','anthropic','gemini','groq','cohere','mistral','azure-openai','custom'))
);

CREATE INDEX IF NOT EXISTS idx_vault_seller ON vault_api_keys(seller_id) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_vault_provider ON vault_api_keys(provider) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_vault_platform_pool ON vault_api_keys(is_platform_pool) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_vault_rotation ON vault_api_keys(rotation_due_at) WHERE is_active = TRUE;

DROP TRIGGER IF EXISTS trg_vault_updated_at ON vault_api_keys;
CREATE TRIGGER trg_vault_updated_at BEFORE UPDATE ON vault_api_keys
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

COMMENT ON TABLE vault_api_keys IS 'Cofre AES-256-GCM. is_platform_pool=TRUE para Classe B (injetadas pelo admin).';
COMMENT ON COLUMN vault_api_keys.key_fingerprint IS 'SHA-256 truncado para auditoria sem expor chave plain.';
COMMENT ON COLUMN vault_api_keys.encrypted_key IS 'AES-256-GCM. Decrypt: VAULT_AES_KEY (.env) + iv + auth_tag.';

-- ------------------------------------------------------------
-- VAULT_KEY_USAGE: log granular de uso (auditoria + billing Classe B)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vault_key_usage (
    id                      BIGSERIAL PRIMARY KEY,
    vault_key_id            UUID NOT NULL REFERENCES vault_api_keys(id) ON DELETE CASCADE,
    seller_id               UUID REFERENCES sellers(id) ON DELETE SET NULL,
    product_id              UUID,                        -- FK adicionada em migration de produtos
    operation               VARCHAR(50),                 -- ex: 'embeddings', 'completion', 'image'
    model                   VARCHAR(80),
    tokens_input            INT,
    tokens_output           INT,
    cost_usd_cents          BIGINT NOT NULL DEFAULT 0,
    duration_ms             INT,
    success                 BOOLEAN NOT NULL DEFAULT TRUE,
    error_message           TEXT,
    ip_address              INET,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vault_usage_key ON vault_key_usage(vault_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vault_usage_seller ON vault_key_usage(seller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vault_usage_created ON vault_key_usage(created_at DESC);

COMMENT ON TABLE vault_key_usage IS 'Granular log de uso de keys da plataforma. Particionar mensalmente em producao.';

-- ------------------------------------------------------------
-- SELLER_SLA_HISTORY: historico de violacoes/revogacoes SLA
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seller_sla_history (
    id                      BIGSERIAL PRIMARY KEY,
    seller_id               UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
    event                   VARCHAR(50) NOT NULL,        -- 'warning_sent', 'revoked', 'reactivated'
    deadline_was            TIMESTAMPTZ,
    actual_upload_at        TIMESTAMPTZ,
    days_overdue            INT,
    actor_user_id           UUID REFERENCES users(id),   -- NULL se foi cron automatico
    notes                   TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sla_history_seller ON seller_sla_history(seller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sla_history_event ON seller_sla_history(event);

COMMENT ON TABLE seller_sla_history IS 'Trilha de eventos SLA. Usado no dashboard do seller (cronometro) e admin (auditoria).';

-- ------------------------------------------------------------
-- SELLER_PAYOUTS: solicitacoes/registros de saque
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seller_payouts (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    seller_id               UUID NOT NULL REFERENCES sellers(id) ON DELETE RESTRICT,
    amount_cents            BIGINT NOT NULL,
    status                  VARCHAR(30) NOT NULL DEFAULT 'pending',  -- pending|approved|paid|rejected|cancelled
    asaas_transfer_id       VARCHAR(60),
    requested_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    approved_at             TIMESTAMPTZ,
    approved_by             UUID REFERENCES users(id),
    paid_at                 TIMESTAMPTZ,
    rejected_reason         TEXT,
    metadata                JSONB DEFAULT '{}'::JSONB,

    CONSTRAINT payouts_amount_positive CHECK (amount_cents > 0)
);

CREATE INDEX IF NOT EXISTS idx_payouts_seller ON seller_payouts(seller_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_payouts_status ON seller_payouts(status);

COMMENT ON TABLE seller_payouts IS 'Solicitacoes de saque. Status pending => admin aprova => Asaas transfer.';
