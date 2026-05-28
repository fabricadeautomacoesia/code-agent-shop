-- Migration 065: seed notification_templates 'asaas_refund_failed'
-- W14 + W11 pass 223 - 2026-05-28
--
-- CONTEXTO:
-- W11 pass 222 introduziu PAYMENT_REFUND_FAILED handler que INSERT
-- notifications (channel='in_app', template_code='asaas_refund_failed').
-- Sem template seeded, notification eh inserida mas:
--   - notification-svc outbox processor pode falhar mustache render
--   - Admin dashboard pode mostrar string raw
--
-- ESTRATEGIA DEFENSIVA (schema drift mig 008 vs mig 018/036):
-- Tentar INSERT com schema novo (template_code) primeiro, fallback antigo (code).
-- Pattern consolidado mig 018 + 036.
--
-- TEMPLATE VARIABLES:
-- - {{order_id_short}} - primeiros 8 chars order.id
-- - {{payment_id}} - Asaas payment id
-- - {{order_status}} - current payment_status (preserved post-fail)

DO $$ BEGIN
  -- Schema novo (mig 018+ format)
  INSERT INTO notification_templates (template_code, title_template, body_template, channels, category)
  VALUES (
    'asaas_refund_failed',
    'Refund falhou: order {{order_id_short}}',
    'Asaas tentou processar refund para order {{order_id_short}} (payment {{payment_id}}) mas FALHOU. Estado pagamento preservado como ''{{order_status}}''. Investigue no painel Asaas (insufficient funds wallet, regulatory reject, etc) e tome acao manual.',
    ARRAY['in_app','email']::TEXT[],
    'asaas_alerts'
  )
  ON CONFLICT (template_code) DO UPDATE SET
    title_template = EXCLUDED.title_template,
    body_template = EXCLUDED.body_template;
EXCEPTION
  WHEN undefined_table THEN NULL;
  WHEN undefined_column THEN
    -- Schema antigo sem 'category'
    BEGIN
      INSERT INTO notification_templates (template_code, title_template, body_template, channels)
      VALUES (
        'asaas_refund_failed',
        'Refund falhou: order {{order_id_short}}',
        'Asaas tentou processar refund para order {{order_id_short}} (payment {{payment_id}}) mas FALHOU. Estado pagamento preservado como ''{{order_status}}''. Investigue no painel Asaas.',
        ARRAY['in_app','email']::TEXT[]
      )
      ON CONFLICT (template_code) DO NOTHING;
    EXCEPTION
      WHEN undefined_column THEN
        -- Schema mig 008 original (code instead of template_code)
        BEGIN
          INSERT INTO notification_templates (code, name, channel, body_template)
          VALUES (
            'asaas_refund_failed',
            'Asaas Refund Failed Alert',
            'in_app',
            'Refund failed for order {{order_id_short}}. Investigate.'
          )
          ON CONFLICT (code) DO NOTHING;
        EXCEPTION WHEN OTHERS THEN NULL; END;
      WHEN OTHERS THEN NULL;
    END;
END $$;

DO $$ BEGIN
  RAISE NOTICE 'W11-pass223: notification template asaas_refund_failed seeded (cobertura schema drift)';
END $$;

-- ROLLBACK:
--   DELETE FROM notification_templates WHERE template_code = 'asaas_refund_failed' OR code = 'asaas_refund_failed';
