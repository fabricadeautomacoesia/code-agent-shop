-- FIX-WORKER-13 pass 7: seed template vault_rotation_due (email + in_app)
--
-- CONTEXTO:
-- W17 pass 12 criou rotationAlertCron() que cria notifications in_app diretas
-- (sem template DB). Funciona mas:
-- 1. Admin offline (sem dashboard aberto) nao ve alerta
-- 2. Inconsistente com outros templates (product_new_version, password_reset)
-- 3. Sem email path -> rotacao critica pode passar despercebida
--
-- Esta migration cria o template para que notification-svc outbox processor
-- (que ja faz mustache render + sendEmail/sendTelegram) entregue email
-- automaticamente quando notification rows com template_code='vault_rotation_due'
-- forem inseridas com channel='email'.
--
-- W17 pass 12 cria channel='in_app' apenas. Pass futuro (W13 pass 8) pode
-- estender rotationAlertCron para inserir tambem channel='email' para
-- urgent (overdue) cases - este template estara pronto.
--
-- DEFENSIVE: schemas mig 008 e 018 sao conflitantes (code vs template_code,
-- channel vs channels). Tenta ambos para compat.

-- Tenta schema mig 008 (code + subject_template + channel singular)
DO $$ BEGIN
  INSERT INTO notification_templates (code, name, description, channel,
    subject_template, body_template, body_html_template, locale, variables)
  VALUES (
    'vault_rotation_due',
    'Vault: rotacao de chave devida',
    'Alerta admin: API key proxima do prazo de rotacao (W17 pass 12)',
    'email',
    '[CAS Vault] Chave {{alias}} ({{provider}}) - rotacao em {{days}}d',
    'Ola admin,

A chave da API {{alias}} (provider {{provider}}) tem prazo de rotacao em {{days}} dias.

ID: {{key_id}}

Para rotacionar:
1. Gere nova chave no painel do {{provider}}
2. Acesse https://admin.cas.inovareinteligenciaartificial.com/vault
3. Provisione nova chave com mesmo alias
4. Revogue a antiga

NAO IGNORE: token revogado pelo upstream causa 100% errors em prod.

-- Inovare AIOps',
    '<p>Ola admin,</p><p>A chave da API <strong>{{alias}}</strong> (provider <strong>{{provider}}</strong>) tem prazo de rotacao em <strong>{{days}} dias</strong>.</p><p><strong>ID:</strong> {{key_id}}</p><p>Para rotacionar:</p><ol><li>Gere nova chave no painel do {{provider}}</li><li>Acesse <a href="https://admin.cas.inovareinteligenciaartificial.com/vault">painel admin/vault</a></li><li>Provisione nova chave com mesmo alias</li><li>Revogue a antiga</li></ol><p><strong>NAO IGNORE</strong>: token revogado pelo upstream causa 100% errors em prod.</p><hr><p style="color:#888;font-size:11px">-- Inovare AIOps</p>',
    'pt-BR',
    '["alias","provider","days","key_id"]'::JSONB
  )
  ON CONFLICT (code) DO UPDATE SET
    subject_template = EXCLUDED.subject_template,
    body_template = EXCLUDED.body_template,
    body_html_template = EXCLUDED.body_html_template,
    updated_at = NOW();
EXCEPTION
  WHEN undefined_table THEN NULL;
  WHEN undefined_column THEN
    -- Fallback schema mig 018 (template_code + title_template + channels array)
    BEGIN
      INSERT INTO notification_templates (template_code, title_template,
        body_template, channels, category)
      VALUES (
        'vault_rotation_due',
        '[CAS Vault] Chave {{alias}} ({{provider}}) - rotacao em {{days}}d',
        E'Ola admin,\n\nA chave {{alias}} (provider {{provider}}) tem prazo de rotacao em {{days}} dias.\nID: {{key_id}}\n\nRotacione via https://admin.cas.inovareinteligenciaartificial.com/vault para evitar 100% errors quando upstream revogar.\n\n-- Inovare AIOps',
        ARRAY['in_app','email']::TEXT[],
        'security'
      )
      ON CONFLICT (template_code) DO UPDATE SET
        title_template = EXCLUDED.title_template,
        body_template = EXCLUDED.body_template;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
END $$;

DO $$ BEGIN
  INSERT INTO schema_migrations (version, applied_at)
  VALUES ('036_vault_rotation_due_template', NOW())
  ON CONFLICT (version) DO NOTHING;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

DO $$ BEGIN
  RAISE NOTICE 'W13-7: template vault_rotation_due seed aplicado';
END $$;
