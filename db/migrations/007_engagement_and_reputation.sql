-- ============================================================
-- 007_engagement_and_reputation.sql
-- Reviews, Q&A, denuncias, disputas, reputacao
-- ============================================================

-- ------------------------------------------------------------
-- PRODUCT_REVIEWS: avaliacoes dos compradores
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_reviews (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id              UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    order_id                UUID REFERENCES orders(id) ON DELETE SET NULL,
    buyer_user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    seller_id               UUID REFERENCES sellers(id) ON DELETE SET NULL,
    rating                  SMALLINT NOT NULL,
    title                   VARCHAR(200),
    body                    TEXT,
    is_verified_purchase    BOOLEAN NOT NULL DEFAULT FALSE,
    helpful_count           INT NOT NULL DEFAULT 0,
    unhelpful_count         INT NOT NULL DEFAULT 0,
    reply_from_seller       TEXT,
    reply_at                TIMESTAMPTZ,
    is_hidden               BOOLEAN NOT NULL DEFAULT FALSE,
    hidden_reason           VARCHAR(120),
    sentiment_score         NUMERIC(4,3),                -- NLP -1..1 (worker pode preencher)
    metadata                JSONB DEFAULT '{}'::JSONB,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT review_rating_chk CHECK (rating BETWEEN 1 AND 5),
    CONSTRAINT review_unique_per_order UNIQUE(order_id, product_id, buyer_user_id)
);

CREATE INDEX IF NOT EXISTS idx_reviews_product ON product_reviews(product_id, created_at DESC) WHERE is_hidden = FALSE;
CREATE INDEX IF NOT EXISTS idx_reviews_seller ON product_reviews(seller_id, created_at DESC) WHERE is_hidden = FALSE;
CREATE INDEX IF NOT EXISTS idx_reviews_buyer ON product_reviews(buyer_user_id);
CREATE INDEX IF NOT EXISTS idx_reviews_rating ON product_reviews(product_id, rating);
CREATE INDEX IF NOT EXISTS idx_reviews_verified ON product_reviews(is_verified_purchase) WHERE is_verified_purchase = TRUE;

DROP TRIGGER IF EXISTS trg_reviews_updated_at ON product_reviews;
CREATE TRIGGER trg_reviews_updated_at BEFORE UPDATE ON product_reviews
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

COMMENT ON TABLE product_reviews IS '1 review por (order, product, buyer). is_verified_purchase requer order paga.';

-- ------------------------------------------------------------
-- REVIEW_VOTES: helpful / unhelpful por usuario
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS review_votes (
    review_id               UUID NOT NULL REFERENCES product_reviews(id) ON DELETE CASCADE,
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vote                    SMALLINT NOT NULL,           -- 1 helpful, -1 unhelpful
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(review_id, user_id),
    CONSTRAINT vote_chk CHECK (vote IN (1, -1))
);

-- ------------------------------------------------------------
-- PRODUCT_QNA: perguntas e respostas no PDP (Mercado Livre style)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_qna (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id              UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    seller_id               UUID REFERENCES sellers(id) ON DELETE SET NULL,
    asked_by_user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
    answered_by_user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    question                TEXT NOT NULL,
    answer                  TEXT,
    is_pinned               BOOLEAN NOT NULL DEFAULT FALSE,
    is_public               BOOLEAN NOT NULL DEFAULT TRUE,
    is_hidden               BOOLEAN NOT NULL DEFAULT FALSE,
    upvote_count            INT NOT NULL DEFAULT 0,
    asked_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    answered_at             TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qna_product ON product_qna(product_id, asked_at DESC) WHERE is_hidden = FALSE;
CREATE INDEX IF NOT EXISTS idx_qna_seller_pending ON product_qna(seller_id)
    WHERE answer IS NULL AND is_hidden = FALSE;
CREATE INDEX IF NOT EXISTS idx_qna_pinned ON product_qna(product_id, is_pinned) WHERE is_pinned = TRUE;

DROP TRIGGER IF EXISTS trg_qna_updated_at ON product_qna;
CREATE TRIGGER trg_qna_updated_at BEFORE UPDATE ON product_qna
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

COMMENT ON TABLE product_qna IS 'Q&A publico (Mercado Livre style). Seller dashboard mostra pendentes.';

-- ------------------------------------------------------------
-- REPORTS: denuncias de produtos/sellers/reviews
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reports (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
    target_type             VARCHAR(30) NOT NULL,        -- 'product'|'seller'|'review'|'user'|'qna'
    target_id               UUID NOT NULL,
    reason_code             VARCHAR(50) NOT NULL,        -- 'plagiarism','spam','scam','offensive','copyright','other'
    description             TEXT,
    evidence_urls           TEXT[],
    status                  VARCHAR(30) NOT NULL DEFAULT 'open', -- open|under_review|resolved|dismissed
    resolved_by             UUID REFERENCES users(id),
    resolution_notes        TEXT,
    resolved_at             TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at DESC);

COMMENT ON TABLE reports IS 'Denuncias. Admin dashboard mostra status=open. Pode disparar suspend automatico.';

-- ------------------------------------------------------------
-- DISPUTES: mediacao formal (proteção ao comprador)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS disputes (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id                UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
    order_item_id           UUID REFERENCES order_items(id) ON DELETE RESTRICT,
    opened_by_user_id       UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    against_seller_id       UUID REFERENCES sellers(id) ON DELETE SET NULL,
    reason_code             VARCHAR(60) NOT NULL,        -- 'not_as_described','not_working','plagiarism','support_missing'
    description             TEXT NOT NULL,
    requested_resolution    VARCHAR(30) NOT NULL,        -- 'refund'|'replacement'|'partial_refund'|'support'
    status                  dispute_status NOT NULL DEFAULT 'opened',
    refund_amount_cents     BIGINT,
    mediator_user_id        UUID REFERENCES users(id),
    mediator_notes          TEXT,
    evidence_urls           TEXT[],
    seller_response         TEXT,
    seller_responded_at     TIMESTAMPTZ,
    resolved_at             TIMESTAMPTZ,
    resolved_in_favor_of    VARCHAR(10),                 -- 'buyer'|'seller'|'split'
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_disputes_order ON disputes(order_id);
CREATE INDEX IF NOT EXISTS idx_disputes_seller ON disputes(against_seller_id);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status);
CREATE INDEX IF NOT EXISTS idx_disputes_open ON disputes(created_at DESC) WHERE status IN ('opened','under_review');

DROP TRIGGER IF EXISTS trg_disputes_updated_at ON disputes;
CREATE TRIGGER trg_disputes_updated_at BEFORE UPDATE ON disputes
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ------------------------------------------------------------
-- DISPUTE_MESSAGES: thread da disputa
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dispute_messages (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dispute_id              UUID NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
    sender_user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender_role             user_role NOT NULL,
    message                 TEXT NOT NULL,
    attachments             TEXT[],
    is_internal             BOOLEAN NOT NULL DEFAULT FALSE,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dmsg_dispute ON dispute_messages(dispute_id, created_at);

-- ------------------------------------------------------------
-- SELLER_REPUTATION_HISTORY: snapshot diario do score (analytics + grafico evolutivo)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seller_reputation_history (
    id                      BIGSERIAL PRIMARY KEY,
    seller_id               UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
    snapshot_date           DATE NOT NULL,
    tier                    reputation_tier NOT NULL,
    score                   INT NOT NULL,
    total_sales             BIGINT NOT NULL,
    avg_rating              NUMERIC(3,2),
    review_count            INT NOT NULL,
    dispute_rate            NUMERIC(5,4),                -- disputas / vendas
    refund_rate             NUMERIC(5,4),
    avg_response_time_hours NUMERIC(8,2),
    sla_compliance_pct      NUMERIC(5,4),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(seller_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_rep_hist_seller ON seller_reputation_history(seller_id, snapshot_date DESC);

COMMENT ON TABLE seller_reputation_history IS 'Snapshot diario por cron. Permite graficos evolutivos no seller dashboard.';

-- ------------------------------------------------------------
-- FOLLOWS: usuarios seguem sellers
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seller_follows (
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    seller_id               UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
    notify_new_product      BOOLEAN NOT NULL DEFAULT TRUE,
    notify_promotion        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(user_id, seller_id)
);

CREATE INDEX IF NOT EXISTS idx_follows_seller ON seller_follows(seller_id);
