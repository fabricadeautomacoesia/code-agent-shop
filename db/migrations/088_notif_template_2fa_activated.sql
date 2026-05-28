-- Migration 088: notification template 2fa_activated
-- W6 pass 372 + 391 (schema fix - paridade mig 067)
--
-- CONTEXTO:
-- Pass 372 adicionou notification em /auth/2fa/activate (gap paridade
-- /recovery pass 220 e /disable pass 286).
--
-- BUG ORIGINAL pass 372 (corrigido pass 391):
-- Migration original usava colunas `title/body/priority/category` que NAO
-- existem em prod (drift entre mig 008 schema antigo e migs intermediarias).
-- Aplicacao falhava silenciosa - template '2fa_activated' nunca seed.
-- Resultado: notification 'Autenticacao em 2 fatores ativada' enviada com
-- template_code='2fa_activated' inexistente -> outbox usa title/body do INSERT
-- direto pass 372 (graceful fallback) MAS sem registry seed = inconsistencia.
--
-- POST-FIX pass 391: 3-layer fallback INSERT (paridade mig 067 pass 225):
-- LAYER 1: schema atual com category column (post-mig 067)
-- LAYER 2: schema sem category (intermediate)
-- LAYER 3: schema original mig 008 (template_code -> code)
--
-- Pattern industry: TODA mudanca 2FA notifica all devices anti-takeover.

DO $$
BEGIN
  -- LAYER 1: schema atual (template_code + title_template + body_template + channels + category)
  BEGIN
    INSERT INTO notification_templates
      (template_code, title_template, body_template, channels, category)
    VALUES (
      '2fa_activated',
      'Autenticacao em 2 fatores ativada',
      'A autenticacao 2FA foi ativada em sua conta. Se nao foi voce, troque sua senha imediatamente em /conta/seguranca e desative 2FA via codigos de recuperacao.',
      ARRAY['in_app','email']::TEXT[],
      'security'
    )
    ON CONFLICT (template_code) DO UPDATE SET
      title_template = EXCLUDED.title_template,
      body_template = EXCLUDED.body_template,
      category = EXCLUDED.category;
  EXCEPTION
    WHEN undefined_column THEN
      -- LAYER 2: schema sem category column
      BEGIN
        INSERT INTO notification_templates
          (template_code, title_template, body_template, channels)
        VALUES (
          '2fa_activated',
          'Autenticacao em 2 fatores ativada',
          'A autenticacao 2FA foi ativada em sua conta. Se nao foi voce, troque sua senha imediatamente em /conta/seguranca e desative 2FA via codigos de recuperacao.',
          ARRAY['in_app','email']::TEXT[]
        )
        ON CONFLICT (template_code) DO UPDATE SET
          title_template = EXCLUDED.title_template,
          body_template = EXCLUDED.body_template;
      EXCEPTION
        WHEN undefined_column THEN
          -- LAYER 3: schema original mig 008 (code + name + channel + body_template)
          INSERT INTO notification_templates
            (code, name, channel, body_template)
          VALUES (
            '2fa_activated',
            '2FA Activated',
            'in_app',
            'A autenticacao 2FA foi ativada em sua conta. Se nao foi voce, troque sua senha imediatamente.'
          )
          ON CONFLICT (code) DO UPDATE SET
            body_template = EXCLUDED.body_template;
      END;
  END;
  RAISE NOTICE 'W6-pass391: template 2fa_activated seeded (3-layer fallback)';
END $$;
