-- ============================================================
-- 001_extensions_and_enums.sql
-- Code & Agent Shop - Extensoes PostgreSQL e tipos ENUM globais
-- Idempotente: pode rodar multiplas vezes sem erro
-- ============================================================

-- Extensoes obrigatorias
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";       -- uuid_generate_v4()
CREATE EXTENSION IF NOT EXISTS "pgcrypto";         -- gen_random_uuid(), digest, hmac
CREATE EXTENSION IF NOT EXISTS "citext";           -- email case-insensitive
CREATE EXTENSION IF NOT EXISTS "pg_trgm";          -- busca fuzzy / similarity
CREATE EXTENSION IF NOT EXISTS "unaccent";         -- search sem acentos
CREATE EXTENSION IF NOT EXISTS "btree_gin";        -- indices GIN compostos
CREATE EXTENSION IF NOT EXISTS "tablefunc";        -- crosstab / pivot

-- ============================================================
-- ENUMs (criados com DO $$ ... $$ para tolerar re-execucao)
-- ============================================================

DO $$ BEGIN
    CREATE TYPE user_role AS ENUM (
        'buyer',
        'seller',
        'admin',
        'staff',
        'support'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE seller_class AS ENUM (
        'class_a',   -- Independente, proprias API keys
        'class_b'    -- Patrocinado Cloud Code Ilimitado, keys do vault
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE seller_status AS ENUM (
        'pending_kyc',
        'active',
        'suspended',
        'banned',
        'sla_revoked'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE product_status AS ENUM (
        'draft',
        'submitted',
        'qa_pending',
        'qa_running',
        'approved',
        'rejected',
        'paused',
        'archived',
        'platform_owned'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE product_kind AS ENUM (
        'automation',
        'ai_agent',
        'n8n_workflow',
        'node_script',
        'python_script',
        'php_script',
        'prompt_pack',
        'template',
        'dataset',
        'other'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE license_kind AS ENUM (
        'single_use',
        'unlimited',
        'subscription_monthly',
        'subscription_yearly'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE order_status AS ENUM (
        'cart',
        'pending_payment',
        'paid',
        'fulfilled',
        'disputed',
        'refunded',
        'cancelled',
        'expired'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE payment_method AS ENUM (
        'pix',
        'credit_card',
        'boleto'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE payment_status AS ENUM (
        'pending',
        'authorized',
        'captured',
        'failed',
        'refunded',
        'chargeback'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE qa_verdict AS ENUM (
        'pending',
        'running',
        'approved',
        'rejected',
        'error'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE dispute_status AS ENUM (
        'opened',
        'under_review',
        'resolved_buyer',
        'resolved_seller',
        'cancelled'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE notification_channel AS ENUM (
        'email',
        'push',
        'whatsapp',
        'in_app',
        'telegram'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE audit_severity AS ENUM (
        'info',
        'warn',
        'error',
        'critical'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE reputation_tier AS ENUM (
        'iniciante',     -- 0-9 vendas
        'bronze',        -- 10-49
        'prata',         -- 50-199
        'ouro',          -- 200-999
        'platinum',      -- 1000-4999
        'lider_platinum' -- 5000+
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- FUNCAO updated_at automatica (trigger reusable)
-- ============================================================
CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION fn_set_updated_at() IS
'Trigger function: atualiza coluna updated_at para NOW() em qualquer UPDATE';
