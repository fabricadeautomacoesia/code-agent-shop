-- ============================================================
-- 005_products.sql
-- Catalogo de produtos (automacoes, agentes IA, workflows, scripts)
-- ============================================================

-- ------------------------------------------------------------
-- PRODUCTS: tabela principal do catalogo
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    seller_id               UUID REFERENCES sellers(id) ON DELETE RESTRICT,
    category_id             UUID REFERENCES categories(id) ON DELETE RESTRICT,
    kind                    product_kind NOT NULL,
    status                  product_status NOT NULL DEFAULT 'draft',

    -- Identidade publica
    slug                    VARCHAR(200) NOT NULL UNIQUE,
    title                   VARCHAR(200) NOT NULL,
    subtitle                VARCHAR(300),
    description             TEXT NOT NULL,
    description_html        TEXT,                        -- rendered markdown
    short_description       VARCHAR(500),

    -- Preco
    price_cents             BIGINT NOT NULL,
    currency                VARCHAR(3) NOT NULL DEFAULT 'BRL',
    license_kind            license_kind NOT NULL DEFAULT 'single_use',
    is_free                 BOOLEAN GENERATED ALWAYS AS (price_cents = 0) STORED,

    -- Tecnico
    tech_stack              TEXT[],                      -- ex: ['Node.js','PostgreSQL','OpenAI']
    requirements            TEXT,                        -- markdown
    install_instructions    TEXT,                        -- markdown
    api_keys_required       TEXT[],                      -- ex: ['OPENAI_API_KEY']
    estimated_install_min   INT,

    -- Capas e midia
    cover_image_url         TEXT,
    gallery_urls            TEXT[],
    demo_url                TEXT,
    video_url               TEXT,

    -- Arquivos do produto
    package_url             TEXT,                        -- ZIP/JSON criptografado
    package_hash_sha256     VARCHAR(64),
    package_size_bytes      BIGINT,

    -- Clausula Master de Revenda Direta
    platform_resale_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    is_platform_owned       BOOLEAN NOT NULL DEFAULT FALSE,  -- TRUE = venda direta 100% lucro

    -- QA / Aprovacao
    qa_verdict              qa_verdict NOT NULL DEFAULT 'pending',
    qa_confidence_score     NUMERIC(5,4),                -- 0.0000-1.0000
    qa_last_check_at        TIMESTAMPTZ,
    qa_reasons              TEXT[],                      -- razoes da ultima rejeicao
    submitted_at            TIMESTAMPTZ,
    approved_at             TIMESTAMPTZ,
    approved_by             UUID REFERENCES users(id),
    rejected_at             TIMESTAMPTZ,
    rejected_reason         TEXT,

    -- Estatisticas (atualizadas via worker/trigger)
    view_count              BIGINT NOT NULL DEFAULT 0,
    sales_count             BIGINT NOT NULL DEFAULT 0,
    revenue_cents_total     BIGINT NOT NULL DEFAULT 0,
    review_count            INT NOT NULL DEFAULT 0,
    avg_rating              NUMERIC(3,2),
    qna_count               INT NOT NULL DEFAULT 0,
    qna_unanswered_count    INT NOT NULL DEFAULT 0,

    -- SEO
    meta_title              VARCHAR(200),
    meta_description        TEXT,
    meta_keywords           TEXT[],

    -- Search
    search_tsv              TSVECTOR,                    -- gerado via trigger

    -- Atributos especificos por categoria (filtros facetados)
    attributes              JSONB NOT NULL DEFAULT '{}'::JSONB,

    -- Custom
    metadata                JSONB NOT NULL DEFAULT '{}'::JSONB,

    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at            TIMESTAMPTZ,
    archived_at             TIMESTAMPTZ,
    deleted_at              TIMESTAMPTZ,

    CONSTRAINT products_price_chk CHECK (price_cents >= 0),
    CONSTRAINT products_slug_chk CHECK (slug ~ '^[a-z0-9][a-z0-9-]{2,198}[a-z0-9]$'),
    CONSTRAINT products_confidence_chk CHECK (qa_confidence_score IS NULL OR (qa_confidence_score BETWEEN 0 AND 1)),
    CONSTRAINT products_rating_chk CHECK (avg_rating IS NULL OR (avg_rating BETWEEN 0 AND 5)),
    CONSTRAINT products_seller_or_platform CHECK (
        seller_id IS NOT NULL OR is_platform_owned = TRUE
    )
);

-- Indices estrategicos
CREATE INDEX IF NOT EXISTS idx_products_seller ON products(seller_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_products_kind ON products(kind);
CREATE INDEX IF NOT EXISTS idx_products_approved ON products(approved_at DESC) WHERE status = 'approved';
CREATE INDEX IF NOT EXISTS idx_products_price ON products(price_cents) WHERE status = 'approved';
CREATE INDEX IF NOT EXISTS idx_products_rating ON products(avg_rating DESC NULLS LAST, sales_count DESC) WHERE status = 'approved';
CREATE INDEX IF NOT EXISTS idx_products_sales ON products(sales_count DESC) WHERE status = 'approved';
CREATE INDEX IF NOT EXISTS idx_products_platform_owned ON products(is_platform_owned) WHERE status = 'approved';
CREATE INDEX IF NOT EXISTS idx_products_search_tsv ON products USING GIN (search_tsv);
CREATE INDEX IF NOT EXISTS idx_products_attributes_gin ON products USING GIN (attributes);
CREATE INDEX IF NOT EXISTS idx_products_metadata_gin ON products USING GIN (metadata);
CREATE INDEX IF NOT EXISTS idx_products_title_trgm ON products USING GIN (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_products_techstack_gin ON products USING GIN (tech_stack);

-- Trigger updated_at
DROP TRIGGER IF EXISTS trg_products_updated_at ON products;
CREATE TRIGGER trg_products_updated_at BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- Trigger search_tsv (full-text indexer)
CREATE OR REPLACE FUNCTION fn_products_tsv_update()
RETURNS TRIGGER AS $$
BEGIN
    NEW.search_tsv :=
        setweight(to_tsvector('portuguese', unaccent(coalesce(NEW.title, ''))),    'A') ||
        setweight(to_tsvector('portuguese', unaccent(coalesce(NEW.subtitle, ''))), 'B') ||
        setweight(to_tsvector('portuguese', unaccent(coalesce(NEW.short_description, ''))), 'C') ||
        setweight(to_tsvector('portuguese', unaccent(coalesce(NEW.description, ''))), 'D') ||
        setweight(to_tsvector('portuguese', unaccent(coalesce(array_to_string(NEW.tech_stack, ' '), ''))), 'B') ||
        setweight(to_tsvector('portuguese', unaccent(coalesce(array_to_string(NEW.meta_keywords, ' '), ''))), 'C');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_products_tsv ON products;
CREATE TRIGGER trg_products_tsv BEFORE INSERT OR UPDATE
    OF title, subtitle, short_description, description, tech_stack, meta_keywords
    ON products
    FOR EACH ROW EXECUTE FUNCTION fn_products_tsv_update();

COMMENT ON TABLE products IS 'Catalogo principal. is_platform_owned=TRUE para clausula master de revenda direta (100% lucro plataforma).';
COMMENT ON COLUMN products.qa_confidence_score IS 'Output do LLM QA. >= QA_CONFIDENCE_THRESHOLD (.env, default 0.80) => aprovado.';
COMMENT ON COLUMN products.search_tsv IS 'Gerado automatico via trigger. Indexa pt-BR sem acentos.';
COMMENT ON COLUMN products.attributes IS 'Atributos facetados conforme category_attributes. Ex: { "nodes_count": 12, "trigger_type": "webhook" }';

-- ------------------------------------------------------------
-- PRODUCT_VERSIONS: versionamento do produto (changelog publico)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_versions (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id              UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    version                 VARCHAR(20) NOT NULL,        -- semver: 1.2.3
    is_current              BOOLEAN NOT NULL DEFAULT FALSE,
    changelog               TEXT NOT NULL,
    breaking_changes        BOOLEAN NOT NULL DEFAULT FALSE,
    package_url             TEXT,
    package_hash_sha256     VARCHAR(64),
    package_size_bytes      BIGINT,
    qa_verdict              qa_verdict NOT NULL DEFAULT 'pending',
    qa_confidence_score     NUMERIC(5,4),
    qa_reasons              TEXT[],
    published_at            TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(product_id, version)
);

CREATE INDEX IF NOT EXISTS idx_pv_product ON product_versions(product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pv_current ON product_versions(product_id, is_current) WHERE is_current = TRUE;

-- Garantir apenas 1 is_current=TRUE por produto
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pv_current_per_product
    ON product_versions(product_id) WHERE is_current = TRUE;

COMMENT ON TABLE product_versions IS 'Historico de versoes. UI mostra como changelog. is_current=TRUE para versao live.';

-- ------------------------------------------------------------
-- PRODUCT_TAGS: N:N produtos <-> tags
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_tags (
    product_id              UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    tag_id                  UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(product_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_pt_tag ON product_tags(tag_id);

-- ------------------------------------------------------------
-- PRODUCT_MEDIA: imagens/videos/anexos extras
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_media (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id              UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    kind                    VARCHAR(20) NOT NULL,        -- 'image'|'video'|'pdf'|'attachment'
    url                     TEXT NOT NULL,
    mime_type               VARCHAR(80),
    file_size_bytes         BIGINT,
    width                   INT,
    height                  INT,
    duration_seconds        INT,
    caption                 VARCHAR(300),
    sort_order              INT NOT NULL DEFAULT 0,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pm_product ON product_media(product_id, sort_order);

-- ------------------------------------------------------------
-- PRODUCT_QA_RUNS: log das execucoes do pipeline QA (n8n + LLM)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_qa_runs (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id              UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    product_version_id      UUID REFERENCES product_versions(id) ON DELETE SET NULL,
    triggered_by_user_id    UUID REFERENCES users(id),
    n8n_execution_id        VARCHAR(100),
    verdict                 qa_verdict NOT NULL DEFAULT 'pending',
    confidence_score        NUMERIC(5,4),
    llm_provider            VARCHAR(30),                 -- openai|gemini|groq
    llm_model               VARCHAR(80),
    tokens_input            INT,
    tokens_output           INT,
    cost_usd_cents          BIGINT,
    duration_ms             INT,
    raw_response            JSONB,
    reasons                 TEXT[],
    suggestions             TEXT[],
    sintaxe_ok              BOOLEAN,
    resolves_problem        BOOLEAN,
    is_functional           BOOLEAN,
    started_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at             TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qa_runs_product ON product_qa_runs(product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_qa_runs_verdict ON product_qa_runs(verdict);
CREATE INDEX IF NOT EXISTS idx_qa_runs_n8n ON product_qa_runs(n8n_execution_id);

COMMENT ON TABLE product_qa_runs IS 'Trilha das execucoes do pipeline QA. Sintaxe? Resolve? Mock? + LLM confidence.';

-- ------------------------------------------------------------
-- PRODUCT_VIEWS: log de visualizacoes (analytics)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_views (
    id                      BIGSERIAL PRIMARY KEY,
    product_id              UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    user_id                 UUID REFERENCES users(id) ON DELETE SET NULL,
    ip_address              INET,
    referrer                TEXT,
    utm_source              VARCHAR(60),
    utm_medium              VARCHAR(60),
    utm_campaign            VARCHAR(60),
    user_agent              TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pviews_product ON product_views(product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pviews_created ON product_views(created_at DESC);

COMMENT ON TABLE product_views IS 'Particionar mensalmente em producao. Usado para conversion rate.';

-- ------------------------------------------------------------
-- PRODUCT_WISHLIST: lista de desejos / favoritos
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_wishlist (
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    product_id              UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(user_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_wishlist_product ON product_wishlist(product_id);

-- ------------------------------------------------------------
-- FK retroativa: vault_key_usage.product_id agora aponta para products
-- ------------------------------------------------------------
DO $$ BEGIN
    ALTER TABLE vault_key_usage
        ADD CONSTRAINT fk_vault_usage_product
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
            WHEN undefined_table THEN NULL;
END $$;
