-- ============================================================
-- 002_users_and_auth.sql
-- Identidade, autenticacao, sessoes, 2FA TOTP, fail2ban log
-- ============================================================

-- ------------------------------------------------------------
-- USERS: entidade master de identidade (todos tipos: buyer, seller, admin)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email               CITEXT NOT NULL UNIQUE,
    password_hash       VARCHAR(255) NOT NULL,           -- bcrypt cost 12
    full_name           VARCHAR(200) NOT NULL,
    display_name        VARCHAR(80),
    cpf_cnpj            VARCHAR(20),                     -- mascarado no log
    phone_e164          VARCHAR(20),
    avatar_url          TEXT,
    bio                 TEXT,
    role                user_role NOT NULL DEFAULT 'buyer',
    is_email_verified   BOOLEAN NOT NULL DEFAULT FALSE,
    is_phone_verified   BOOLEAN NOT NULL DEFAULT FALSE,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    is_banned           BOOLEAN NOT NULL DEFAULT FALSE,
    ban_reason          TEXT,
    last_login_at       TIMESTAMPTZ,
    last_login_ip       INET,
    failed_login_count  INT NOT NULL DEFAULT 0,
    locale              VARCHAR(10) NOT NULL DEFAULT 'pt-BR',
    timezone            VARCHAR(50) NOT NULL DEFAULT 'America/Sao_Paulo',
    metadata            JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at          TIMESTAMPTZ,
    CONSTRAINT users_email_chk CHECK (email ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$'),
    CONSTRAINT users_phone_chk CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9]\d{6,14}$')
);

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_metadata_gin ON users USING GIN (metadata);
CREATE INDEX IF NOT EXISTS idx_users_fullname_trgm ON users USING GIN (full_name gin_trgm_ops);

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

COMMENT ON TABLE users IS 'Tabela master de identidade. Usada por buyer, seller, admin, staff.';
COMMENT ON COLUMN users.password_hash IS 'bcrypt cost 12 minimo. Migracao automatica de cost antigos.';
COMMENT ON COLUMN users.metadata IS 'Campo flex JSONB. Ex: { utm_source, referral_code, kyc_data }';
COMMENT ON COLUMN users.cpf_cnpj IS 'Mascarado em logs (DLP). Apenas digitos.';

-- ------------------------------------------------------------
-- USER_TWO_FACTOR: TOTP por usuario (separada para particionar segredos)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_two_factor (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    secret_encrypted    TEXT NOT NULL,                   -- AES-256 do segredo TOTP
    secret_iv           BYTEA NOT NULL,                  -- IV unico
    is_enabled          BOOLEAN NOT NULL DEFAULT FALSE,
    recovery_codes_hash JSONB NOT NULL DEFAULT '[]'::JSONB, -- bcrypt array
    enabled_at          TIMESTAMPTZ,
    disabled_at         TIMESTAMPTZ,
    last_used_at        TIMESTAMPTZ,
    last_used_window    INT,                             -- evita replay do mesmo token
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_2fa_enabled ON user_two_factor(is_enabled);

DROP TRIGGER IF EXISTS trg_user_2fa_updated_at ON user_two_factor;
CREATE TRIGGER trg_user_2fa_updated_at BEFORE UPDATE ON user_two_factor
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

COMMENT ON TABLE user_two_factor IS '2FA TOTP via otplib+qrcode. Segredo AES-256. Recovery codes em bcrypt array.';
COMMENT ON COLUMN user_two_factor.last_used_window IS 'Anti-replay: bloqueia uso do mesmo time-window TOTP.';

-- ------------------------------------------------------------
-- USER_SESSIONS: refresh tokens (access tokens NAO ficam aqui - sao stateless JWT)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_sessions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash  VARCHAR(255) NOT NULL UNIQUE,    -- SHA-256 do refresh token
    user_agent          TEXT,
    ip_address          INET,
    fingerprint         VARCHAR(64),                     -- hash de browser fingerprint
    is_revoked          BOOLEAN NOT NULL DEFAULT FALSE,
    revoked_at          TIMESTAMPTZ,
    revoked_reason      VARCHAR(100),
    expires_at          TIMESTAMPTZ NOT NULL,
    last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions(user_id) WHERE is_revoked = FALSE;
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON user_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_revoked ON user_sessions(is_revoked);

COMMENT ON TABLE user_sessions IS 'Refresh tokens (7d). Access tokens 15min sao stateless e nao ficam aqui.';

-- ------------------------------------------------------------
-- TOKEN_BLACKLIST: access tokens revogados antes do expiry (logout/seguranca)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS token_blacklist (
    jti                 UUID PRIMARY KEY,                -- JWT ID
    user_id             UUID REFERENCES users(id) ON DELETE CASCADE,
    expires_at          TIMESTAMPTZ NOT NULL,
    reason              VARCHAR(100),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_blacklist_expires ON token_blacklist(expires_at);
-- Limpeza automatica via cron: DELETE FROM token_blacklist WHERE expires_at < NOW();

COMMENT ON TABLE token_blacklist IS 'JWT jti revogados. Limpar via cron a cada 1h.';

-- ------------------------------------------------------------
-- PASSWORD_RESETS: tokens de recuperacao
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS password_resets (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash          VARCHAR(255) NOT NULL UNIQUE,    -- SHA-256
    requested_ip        INET,
    used_at             TIMESTAMPTZ,
    expires_at          TIMESTAMPTZ NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pwreset_user ON password_resets(user_id);
CREATE INDEX IF NOT EXISTS idx_pwreset_expires ON password_resets(expires_at);

COMMENT ON TABLE password_resets IS 'Tokens de reset de senha (15min de validade).';

-- ------------------------------------------------------------
-- EMAIL_VERIFICATIONS: tokens de verificacao de email
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_verifications (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email               CITEXT NOT NULL,
    token_hash          VARCHAR(255) NOT NULL UNIQUE,
    verified_at         TIMESTAMPTZ,
    expires_at          TIMESTAMPTZ NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_emailver_user ON email_verifications(user_id);

-- ------------------------------------------------------------
-- FAIL2BAN_LOG: persistencia opcional do fail2ban in-memory (auditoria)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fail2ban_log (
    id                  BIGSERIAL PRIMARY KEY,
    ip_address          INET NOT NULL,
    user_id             UUID REFERENCES users(id) ON DELETE SET NULL,
    route               VARCHAR(200) NOT NULL,
    fail_count          INT NOT NULL DEFAULT 1,
    banned_until        TIMESTAMPTZ,
    user_agent          TEXT,
    metadata            JSONB DEFAULT '{}'::JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fail2ban_ip ON fail2ban_log(ip_address);
CREATE INDEX IF NOT EXISTS idx_fail2ban_banned ON fail2ban_log(banned_until) WHERE banned_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fail2ban_created ON fail2ban_log(created_at DESC);

COMMENT ON TABLE fail2ban_log IS 'Auditoria persistente. Snippet 23.4 (in-memory) eh fonte primaria.';

-- ------------------------------------------------------------
-- AUDIT_LOG: trilha de auditoria global (acoes sensiveis)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
    id                  BIGSERIAL PRIMARY KEY,
    actor_user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
    actor_role          user_role,
    action              VARCHAR(100) NOT NULL,           -- ex: 'seller.suspend', 'product.approve'
    target_type         VARCHAR(50),                     -- ex: 'product', 'order'
    target_id           UUID,
    severity            audit_severity NOT NULL DEFAULT 'info',
    ip_address          INET,
    user_agent          TEXT,
    request_id          UUID,                            -- correlacao com logs do app
    payload_before      JSONB,
    payload_after       JSONB,
    diff                JSONB,
    metadata            JSONB DEFAULT '{}'::JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_severity ON audit_log(severity) WHERE severity IN ('error','critical');
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_payload_gin ON audit_log USING GIN (payload_after);

COMMENT ON TABLE audit_log IS 'Trilha imutavel. Append-only. Particionar por mes em producao (>1M registros).';
