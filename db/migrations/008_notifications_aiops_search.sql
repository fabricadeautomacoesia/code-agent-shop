-- ============================================================
-- 008_notifications_aiops_search.sql
-- Notificacoes, observability, search log, spike detector
-- ============================================================

-- ------------------------------------------------------------
-- NOTIFICATIONS: caixa de mensagens (in_app + outros canais)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel                 notification_channel NOT NULL DEFAULT 'in_app',
    template_code           VARCHAR(80) NOT NULL,        -- ex: 'product_approved','sla_warning_3d'
    title                   VARCHAR(200) NOT NULL,
    body                    TEXT NOT NULL,
    body_html               TEXT,
    cta_label               VARCHAR(60),
    cta_url                 TEXT,
    icon                    VARCHAR(60),
    priority                SMALLINT NOT NULL DEFAULT 0, -- 0 normal, 1 high, 2 critical
    payload                 JSONB DEFAULT '{}'::JSONB,
    is_read                 BOOLEAN NOT NULL DEFAULT FALSE,
    read_at                 TIMESTAMPTZ,
    sent_status             VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending|sent|failed|delivered
    sent_at                 TIMESTAMPTZ,
    failed_reason           TEXT,
    retry_count             INT NOT NULL DEFAULT 0,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notif_user_unread ON notifications(user_id, created_at DESC) WHERE is_read = FALSE;
CREATE INDEX IF NOT EXISTS idx_notif_pending ON notifications(channel, sent_status) WHERE sent_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_notif_created ON notifications(created_at DESC);

COMMENT ON TABLE notifications IS 'Outbox + inbox. notification-svc processa pending.';

-- ------------------------------------------------------------
-- NOTIFICATION_TEMPLATES: templates parametrizaveis
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_templates (
    code                    VARCHAR(80) PRIMARY KEY,
    name                    VARCHAR(120) NOT NULL,
    description             TEXT,
    channel                 notification_channel NOT NULL,
    subject_template        VARCHAR(300),
    body_template           TEXT NOT NULL,
    body_html_template      TEXT,
    locale                  VARCHAR(10) NOT NULL DEFAULT 'pt-BR',
    variables               JSONB DEFAULT '[]'::JSONB,
    is_active               BOOLEAN NOT NULL DEFAULT TRUE,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_ntpl_updated_at ON notification_templates;
CREATE TRIGGER trg_ntpl_updated_at BEFORE UPDATE ON notification_templates
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ------------------------------------------------------------
-- USER_NOTIFICATION_PREFS: preferencias por canal
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_notification_prefs (
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    template_code           VARCHAR(80) NOT NULL,
    channel                 notification_channel NOT NULL,
    is_enabled              BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY(user_id, template_code, channel)
);

-- ------------------------------------------------------------
-- METRICS_HISTORY: AIOps - CPU/RAM/Disco (retencao 30d)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS metrics_history (
    id                      BIGSERIAL PRIMARY KEY,
    host                    VARCHAR(120) NOT NULL,
    cpu_percent             NUMERIC(5,2),
    ram_percent             NUMERIC(5,2),
    ram_total_mb            BIGINT,
    ram_used_mb             BIGINT,
    disk_percent            NUMERIC(5,2),
    disk_total_gb           NUMERIC(10,2),
    disk_used_gb            NUMERIC(10,2),
    load_avg_1m             NUMERIC(6,2),
    load_avg_5m             NUMERIC(6,2),
    load_avg_15m            NUMERIC(6,2),
    process_count           INT,
    network_in_mb           NUMERIC(12,2),
    network_out_mb          NUMERIC(12,2),
    extras                  JSONB DEFAULT '{}'::JSONB,
    collected_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_metrics_host_time ON metrics_history(host, collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_metrics_collected ON metrics_history(collected_at DESC);

COMMENT ON TABLE metrics_history IS 'Coletado a cada 10s. Cron diario: DELETE WHERE collected_at < NOW() - 30d';

-- ------------------------------------------------------------
-- ALERTS: alertas disparados (telegram/smtp/webhook)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alerts (
    id                      BIGSERIAL PRIMARY KEY,
    severity                audit_severity NOT NULL,
    source                  VARCHAR(60) NOT NULL,        -- 'aiops','spike-detector','fail2ban','qa-failure'
    code                    VARCHAR(80) NOT NULL,
    title                   VARCHAR(200) NOT NULL,
    message                 TEXT NOT NULL,
    target_type             VARCHAR(30),
    target_id               UUID,
    payload                 JSONB DEFAULT '{}'::JSONB,
    channels_sent           TEXT[] DEFAULT ARRAY[]::TEXT[],
    acknowledged_at         TIMESTAMPTZ,
    acknowledged_by         UUID REFERENCES users(id),
    auto_resolved           BOOLEAN NOT NULL DEFAULT FALSE,
    resolved_at             TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts(severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_unack ON alerts(created_at DESC) WHERE acknowledged_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_alerts_source ON alerts(source);

-- ------------------------------------------------------------
-- SPIKE_EVENTS: spike detector financeiro (V8 4.3)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS spike_events (
    id                      BIGSERIAL PRIMARY KEY,
    tenant_id               UUID,                        -- seller_id ou user_id
    tenant_type             VARCHAR(20) NOT NULL,        -- 'seller'|'user'|'global'
    window_start            TIMESTAMPTZ NOT NULL,
    window_end              TIMESTAMPTZ NOT NULL,
    cost_usd_cents          BIGINT NOT NULL,
    threshold_cents         BIGINT NOT NULL,
    action_taken            VARCHAR(30) NOT NULL,        -- 'blocked','warned','no_action'
    block_expires_at        TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_spike_tenant ON spike_events(tenant_type, tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_spike_block_active ON spike_events(block_expires_at) WHERE block_expires_at IS NOT NULL;

-- ------------------------------------------------------------
-- SEARCH_LOG: log de buscas (analytics + sugestoes)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS search_log (
    id                      BIGSERIAL PRIMARY KEY,
    user_id                 UUID REFERENCES users(id) ON DELETE SET NULL,
    query                   TEXT NOT NULL,
    query_normalized        TEXT,
    filters                 JSONB,
    result_count            INT,
    clicked_product_id      UUID REFERENCES products(id) ON DELETE SET NULL,
    click_position          INT,
    duration_ms             INT,
    ip_address              INET,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_searchlog_user ON search_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_searchlog_query ON search_log USING GIN (query_normalized gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_searchlog_created ON search_log(created_at DESC);

COMMENT ON TABLE search_log IS 'Trends, autocomplete, recomendacao. Particionar mensalmente.';

-- ------------------------------------------------------------
-- WEBHOOK_LOG: webhooks de saida (V8 5.3)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_log (
    id                      BIGSERIAL PRIMARY KEY,
    direction               VARCHAR(10) NOT NULL,        -- 'in'|'out'
    target_url              TEXT,
    event_type              VARCHAR(80) NOT NULL,
    payload                 JSONB NOT NULL,
    signature               VARCHAR(255),
    response_status         INT,
    response_body           TEXT,
    duration_ms             INT,
    success                 BOOLEAN,
    error                   TEXT,
    retry_count             INT NOT NULL DEFAULT 0,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whlog_event ON webhook_log(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_whlog_success ON webhook_log(success, created_at DESC);

-- ------------------------------------------------------------
-- VIEW MATERIALIZADA: vw_seller_kpi (refresh diario)
-- ------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_seller_kpi AS
SELECT
    s.id AS seller_id,
    s.user_id,
    s.seller_class,
    s.status,
    s.reputation_tier,
    s.reputation_score,
    COUNT(DISTINCT p.id) FILTER (WHERE p.status = 'approved')   AS products_active,
    COUNT(DISTINCT p.id) FILTER (WHERE p.status = 'qa_pending') AS products_pending_qa,
    COALESCE(SUM(oi.line_total_cents), 0)                       AS gross_revenue_cents,
    COALESCE(SUM(oi.seller_payout_cents), 0)                    AS net_payout_cents,
    COALESCE(SUM(oi.commission_cents), 0)                       AS platform_commission_cents,
    COUNT(DISTINCT oi.order_id)                                 AS total_orders,
    AVG(pr.rating)                                              AS avg_rating,
    COUNT(DISTINCT pr.id)                                       AS review_count,
    COUNT(DISTINCT d.id) FILTER (WHERE d.status IN ('opened','under_review')) AS open_disputes,
    s.sla_next_deadline_at,
    s.updated_at
FROM sellers s
LEFT JOIN products p ON p.seller_id = s.id
LEFT JOIN order_items oi ON oi.seller_id = s.id
LEFT JOIN product_reviews pr ON pr.seller_id = s.id AND pr.is_hidden = FALSE
LEFT JOIN disputes d ON d.against_seller_id = s.id
GROUP BY s.id;

CREATE UNIQUE INDEX IF NOT EXISTS mv_seller_kpi_id ON mv_seller_kpi(seller_id);
CREATE INDEX IF NOT EXISTS mv_seller_kpi_rep ON mv_seller_kpi(reputation_score DESC);

COMMENT ON MATERIALIZED VIEW mv_seller_kpi IS 'Refresh nightly: REFRESH MATERIALIZED VIEW CONCURRENTLY mv_seller_kpi;';
