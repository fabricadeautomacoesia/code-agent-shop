-- Migration 019: Trust signals no PDP (WORKER 16 MLB-NEW)
-- Mercado Livre exibe badges 'Devolucao gratuita 30 dias' + 'Mercado Pago seguro'.
-- Equivalente CAS para digital products:
-- - warranty_days: tempo para refund (default 30, MLB padrao)
-- - support_response_hours: SLA de resposta do seller a Q&A/email (default 48h)
-- - includes_updates: se inclui atualizacoes gratuitas das proximas versoes (default true)
-- - includes_install_support: se seller ajuda na instalacao (default false)

DO $$ BEGIN
  ALTER TABLE products ADD COLUMN warranty_days INT NOT NULL DEFAULT 30;
EXCEPTION WHEN duplicate_column THEN NULL; WHEN undefined_table THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE products ADD COLUMN support_response_hours INT NOT NULL DEFAULT 48;
EXCEPTION WHEN duplicate_column THEN NULL; WHEN undefined_table THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE products ADD COLUMN includes_updates BOOLEAN NOT NULL DEFAULT TRUE;
EXCEPTION WHEN duplicate_column THEN NULL; WHEN undefined_table THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE products ADD COLUMN includes_install_support BOOLEAN NOT NULL DEFAULT FALSE;
EXCEPTION WHEN duplicate_column THEN NULL; WHEN undefined_table THEN NULL; END $$;

DO $$ BEGIN
  INSERT INTO schema_migrations (version, applied_at)
  VALUES ('019_trust_signals', NOW())
  ON CONFLICT (version) DO NOTHING;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;
