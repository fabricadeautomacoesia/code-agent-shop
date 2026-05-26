-- ============================================================
-- 004_categories_and_tags.sql
-- Categorizacao elastica (estilo Mercado Livre), tags, taxonomia
-- ============================================================

-- ------------------------------------------------------------
-- CATEGORIES: arvore hierarquica de categorias (Mega Menu)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_id           UUID REFERENCES categories(id) ON DELETE RESTRICT,
    slug                VARCHAR(80) NOT NULL UNIQUE,
    name                VARCHAR(120) NOT NULL,
    name_singular       VARCHAR(120),
    description         TEXT,
    icon                VARCHAR(80),                     -- nome do icone lucide/heroicons
    cover_image_url     TEXT,
    depth               SMALLINT NOT NULL DEFAULT 0,
    -- path                LTREE,  -- removido: extensao ltree nao disponivel no Postgres existente
    sort_order          INT NOT NULL DEFAULT 0,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    is_featured         BOOLEAN NOT NULL DEFAULT FALSE,
    product_count       INT NOT NULL DEFAULT 0,
    meta_title          VARCHAR(200),
    meta_description    TEXT,
    metadata            JSONB DEFAULT '{}'::JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT cat_slug_chk CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,78}[a-z0-9]$'),
    CONSTRAINT cat_depth_chk CHECK (depth BETWEEN 0 AND 4)
);

CREATE INDEX IF NOT EXISTS idx_cat_parent ON categories(parent_id);
CREATE INDEX IF NOT EXISTS idx_cat_slug ON categories(slug);
CREATE INDEX IF NOT EXISTS idx_cat_featured ON categories(is_featured) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_cat_sort ON categories(parent_id, sort_order);

DROP TRIGGER IF EXISTS trg_cat_updated_at ON categories;
CREATE TRIGGER trg_cat_updated_at BEFORE UPDATE ON categories
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

COMMENT ON TABLE categories IS 'Arvore hierarquica ate 4 niveis. depth=0 raiz. Mega menu storefront.';

-- ------------------------------------------------------------
-- TAGS: tags livres aplicadas em produtos (folksonomy)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tags (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug                VARCHAR(60) NOT NULL UNIQUE,
    name                VARCHAR(80) NOT NULL,
    description         TEXT,
    color_hex           VARCHAR(7),
    usage_count         INT NOT NULL DEFAULT 0,
    is_official         BOOLEAN NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT tag_slug_chk CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$')
);

CREATE INDEX IF NOT EXISTS idx_tags_usage ON tags(usage_count DESC);
CREATE INDEX IF NOT EXISTS idx_tags_name_trgm ON tags USING GIN (name gin_trgm_ops);

-- ------------------------------------------------------------
-- CATEGORY_ATTRIBUTES: atributos especificos por categoria (filtros facetados)
-- Exemplo: cat "n8n_workflow" => atributo "nodes_count" (int)
--          cat "ai_agent"     => atributo "model_compatibility" (multiselect)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS category_attributes (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category_id         UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    key                 VARCHAR(60) NOT NULL,
    label               VARCHAR(120) NOT NULL,
    data_type           VARCHAR(20) NOT NULL,            -- 'string'|'int'|'float'|'bool'|'enum'|'multi_enum'
    enum_options        JSONB,                           -- array de opcoes se enum
    is_required         BOOLEAN NOT NULL DEFAULT FALSE,
    is_filterable       BOOLEAN NOT NULL DEFAULT TRUE,
    is_searchable       BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order          INT NOT NULL DEFAULT 0,
    UNIQUE(category_id, key)
);

CREATE INDEX IF NOT EXISTS idx_catattr_cat ON category_attributes(category_id);

COMMENT ON TABLE category_attributes IS 'Esquema dinamico de atributos por categoria. Filtros facetados storefront.';
