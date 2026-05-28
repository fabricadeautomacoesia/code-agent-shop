-- Migration 088: notification template 2fa_activated
-- W6 pass 372 - 2026-05-28
--
-- CONTEXTO:
-- Pass 372 adicionou notification em /auth/2fa/activate (gap paridade
-- /recovery pass 220 e /disable pass 286).
-- Template seed missing - codigo 2fa_activated nao existia.
--
-- Pattern industry (GitHub/AWS): TODA mudanca 2FA notifica all devices
-- anti-account-takeover. Cenario fraude:
--  1. Atacante captura sessao (XSS/MITM)
--  2. User sem 2FA pre-ativo
--  3. Atacante setup + activate 2FA com seu app
--  4. User perde acesso sem warning + recovery codes nas maos atacante
--
-- POST-FIX: notif template priority 2 (alta - sec setting change).
-- Title curto, body com call-to-action explicito.

INSERT INTO notification_templates (code, title, body, channel, priority, category)
VALUES (
  '2fa_activated',
  'Autenticacao em 2 fatores ativada',
  'A autenticacao 2FA foi ativada em sua conta. Se nao foi voce, troque sua senha imediatamente em /conta/seguranca e desative 2FA via codigos de recuperacao.',
  'in_app',
  2,
  'security'
)
ON CONFLICT (code) DO UPDATE SET
  title = EXCLUDED.title,
  body = EXCLUDED.body,
  priority = EXCLUDED.priority;

DO $$
BEGIN
  RAISE NOTICE 'W6-pass372: template 2fa_activated seeded (paridade /recovery + /disable)';
END $$;
