-- ============================================================
-- 002_seed_admin.sql
-- Admin master inicial (alterar senha no primeiro login)
-- Senha plain inicial: ChangeMe!2026 (bcrypt cost 12)
-- ============================================================

INSERT INTO users (id, email, password_hash, full_name, display_name, role, is_email_verified, is_active)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'fabricadeautomacoes0@gmail.com',
    '$2b$12$rZx5dXqL3K4yV7nQ8pZbZuBQ3vY6hF2gW9sJ8kT1mR0pX4cN5wA6e', -- ChangeMe!2026 (bcrypt cost 12 placeholder)
    'Inovare Admin',
    'admin',
    'admin',
    TRUE,
    TRUE
)
ON CONFLICT (email) DO NOTHING;

-- Note: a hash acima e PLACEHOLDER. A api de bootstrap regenera no primeiro start.
-- Sera substituida automaticamente pelo packages/shared/bcrypt no script bin/seed.js
