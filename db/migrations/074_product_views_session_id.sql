-- Migration 074: product_views.session_id para tracking anonymous
-- W14 pass 250 - 2026-05-28
--
-- CONTEXTO:
-- product_views atualmente tem user_id (NULL p/ anonymous) + ip_address.
-- ip_address INSUFICIENTE p/ correlation anonymous:
-- - NAT/CGNAT: 1000+ users compartilham 1 IP (mobile operators, corporate)
-- - DHCP rotation: mesmo user muda IP entre sessoes
-- - Bots/scrapers poluem IP-based analytics
--
-- USE CASE:
-- Mercado Livre tracking-style: cookie session_id (HMAC random + httpOnly)
-- - Anonymous user navega 10 produtos -> mesmo session_id -> recommendation
--   "produtos vistos juntos" sem precisar login
-- - Login pos-browsing: backfill anonymous -> user_id (CTE)
-- - Bot detection: session_id que viu 1000 produtos em 60s = bot
--
-- POST-FIX:
-- - ADD COLUMN session_id VARCHAR(64) NULL (NULL p/ rows legadas)
-- - Index parcial WHERE session_id IS NOT NULL (anonymous tracking only)
-- - PWA frontend pode gerar/persistir session_id via localStorage + sync
--
-- ROLLBACK: ALTER TABLE product_views DROP COLUMN IF EXISTS session_id;

DO $$
BEGIN
  ALTER TABLE product_views ADD COLUMN IF NOT EXISTS session_id VARCHAR(64);
EXCEPTION
  WHEN duplicate_column THEN NULL;
  WHEN OTHERS THEN
    RAISE NOTICE 'W14-pass250: ALTER product_views ADD session_id error - check manually';
END $$;

-- Index para correlation anonymous (only rows com session_id NOT NULL)
-- Composite (session_id, created_at DESC) cobre queries:
--   "ultimos 10 produtos vistos nesta sessao"
--   "session ativa nas ultimas 24h"
CREATE INDEX IF NOT EXISTS idx_pviews_session
  ON product_views(session_id, created_at DESC)
  WHERE session_id IS NOT NULL;

DO $$
BEGIN
  RAISE NOTICE 'W14-pass250: product_views.session_id + idx_pviews_session created';
END $$;
