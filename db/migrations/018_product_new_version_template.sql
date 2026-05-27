-- Migration 018: Seed notification template product_new_version (WORKER 16 MLB-NEW)
-- Fan-out de notificacao para subscribers (wishlist + buyers) quando seller
-- publica nova versao de produto (changelog).

DO $$ BEGIN
  INSERT INTO notification_templates (template_code, title_template, body_template, channels, category)
  VALUES (
    'product_new_version',
    'Nova versao: {{title}}',
    'O produto "{{title}}" recebeu uma atualizacao v{{version}}.{{breaking_warn}}\nChangelog: {{changelog}}',
    ARRAY['in_app','email']::TEXT[],
    'product_updates'
  )
  ON CONFLICT (template_code) DO UPDATE SET
    title_template = EXCLUDED.title_template,
    body_template = EXCLUDED.body_template;
EXCEPTION
  WHEN undefined_table THEN NULL;
  WHEN undefined_column THEN
    -- Schema mais antigo sem 'category' - tenta sem
    BEGIN
      INSERT INTO notification_templates (template_code, title_template, body_template, channels)
      VALUES ('product_new_version', 'Nova versao: {{title}}',
        'O produto "{{title}}" recebeu uma atualizacao v{{version}}.{{breaking_warn}}\nChangelog: {{changelog}}',
        ARRAY['in_app','email']::TEXT[])
      ON CONFLICT (template_code) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
END $$;

DO $$ BEGIN
  INSERT INTO schema_migrations (version, applied_at)
  VALUES ('018_product_new_version_template', NOW())
  ON CONFLICT (version) DO NOTHING;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;
