-- ============================================================
-- 009_functions_and_views.sql
-- Funcoes utilitarias, views, calculo de reputacao, search ranking
-- ============================================================

-- ------------------------------------------------------------
-- FUNCAO: calcular tier de reputacao baseado em vendas
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_calc_reputation_tier(total_sales BIGINT)
RETURNS reputation_tier AS $$
BEGIN
    RETURN CASE
        WHEN total_sales >= 5000 THEN 'lider_platinum'::reputation_tier
        WHEN total_sales >= 1000 THEN 'platinum'::reputation_tier
        WHEN total_sales >= 200  THEN 'ouro'::reputation_tier
        WHEN total_sales >= 50   THEN 'prata'::reputation_tier
        WHEN total_sales >= 10   THEN 'bronze'::reputation_tier
        ELSE 'iniciante'::reputation_tier
    END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ------------------------------------------------------------
-- FUNCAO: score de reputacao (Mercado Livre style, 0-10000)
-- Combina: vendas (40%) + rating medio (25%) + dispute rate (15%) +
--          response time (10%) + SLA compliance (10%)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_calc_reputation_score(
    p_sales            BIGINT,
    p_avg_rating       NUMERIC,
    p_review_count     INT,
    p_dispute_rate     NUMERIC,
    p_avg_response_h   NUMERIC,
    p_sla_compliance   NUMERIC
) RETURNS INT AS $$
DECLARE
    score_sales      NUMERIC := 0;
    score_rating     NUMERIC := 0;
    score_disputes   NUMERIC := 0;
    score_response   NUMERIC := 0;
    score_sla        NUMERIC := 0;
BEGIN
    -- Vendas (log scale, max 4000)
    score_sales := LEAST(4000, GREATEST(0, LOG(GREATEST(p_sales, 1)) * 600));
    -- Rating (5 estrelas -> 2500, ponderado pelo review_count)
    IF p_avg_rating IS NOT NULL AND p_review_count >= 5 THEN
        score_rating := (p_avg_rating / 5.0) * 2500;
    ELSE
        score_rating := 1000;  -- score neutro para quem nao tem reviews
    END IF;
    -- Disputas (penalidade: 0% disputas = 1500, 10%+ = 0)
    score_disputes := GREATEST(0, 1500 - (COALESCE(p_dispute_rate, 0) * 15000));
    -- Tempo de resposta (Q&A) - 1h ou menos = 1000, 24h+ = 0
    IF p_avg_response_h IS NULL THEN
        score_response := 500;
    ELSE
        score_response := GREATEST(0, LEAST(1000, 1000 - (p_avg_response_h - 1) * 43));
    END IF;
    -- SLA compliance (Classe B): 100% = 1000
    score_sla := COALESCE(p_sla_compliance, 1.0) * 1000;

    RETURN ROUND(score_sales + score_rating + score_disputes + score_response + score_sla)::INT;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

COMMENT ON FUNCTION fn_calc_reputation_score IS 'Score 0-10000. Inspirado Mercado Livre. Recalcular nightly.';

-- ------------------------------------------------------------
-- FUNCAO: atualizar reputacao de um seller especifico
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_refresh_seller_reputation(p_seller_id UUID)
RETURNS VOID AS $$
DECLARE
    v_sales            BIGINT;
    v_avg_rating       NUMERIC;
    v_review_count     INT;
    v_dispute_count    INT;
    v_dispute_rate     NUMERIC;
    v_avg_response_h   NUMERIC;
    v_sla_compliance   NUMERIC;
    v_score            INT;
    v_tier             reputation_tier;
BEGIN
    SELECT COUNT(DISTINCT oi.order_id) INTO v_sales
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE oi.seller_id = p_seller_id AND o.status IN ('paid','fulfilled');

    SELECT AVG(rating), COUNT(*) INTO v_avg_rating, v_review_count
        FROM product_reviews
        WHERE seller_id = p_seller_id AND is_hidden = FALSE;

    SELECT COUNT(*) INTO v_dispute_count
        FROM disputes WHERE against_seller_id = p_seller_id;

    v_dispute_rate := CASE WHEN v_sales > 0 THEN v_dispute_count::NUMERIC / v_sales ELSE 0 END;

    SELECT AVG(EXTRACT(EPOCH FROM (answered_at - asked_at))/3600)::NUMERIC INTO v_avg_response_h
        FROM product_qna
        WHERE seller_id = p_seller_id AND answered_at IS NOT NULL;

    -- SLA Classe B compliance
    SELECT CASE
        WHEN s.seller_class = 'class_b' AND s.sla_revoked_count > 0 THEN 0.5
        WHEN s.seller_class = 'class_b' THEN 1.0
        ELSE 1.0
    END INTO v_sla_compliance FROM sellers s WHERE id = p_seller_id;

    v_score := fn_calc_reputation_score(v_sales, v_avg_rating, v_review_count, v_dispute_rate, v_avg_response_h, v_sla_compliance);
    v_tier  := fn_calc_reputation_tier(v_sales);

    UPDATE sellers
       SET total_sales        = v_sales,
           avg_rating         = v_avg_rating,
           reputation_score   = v_score,
           reputation_tier    = v_tier,
           updated_at         = NOW()
     WHERE id = p_seller_id;

    INSERT INTO seller_reputation_history(
        seller_id, snapshot_date, tier, score, total_sales,
        avg_rating, review_count, dispute_rate, avg_response_time_hours, sla_compliance_pct
    ) VALUES (
        p_seller_id, CURRENT_DATE, v_tier, v_score, v_sales,
        v_avg_rating, v_review_count, v_dispute_rate, v_avg_response_h, v_sla_compliance
    ) ON CONFLICT (seller_id, snapshot_date) DO UPDATE
        SET tier = EXCLUDED.tier, score = EXCLUDED.score,
            total_sales = EXCLUDED.total_sales, avg_rating = EXCLUDED.avg_rating,
            review_count = EXCLUDED.review_count, dispute_rate = EXCLUDED.dispute_rate;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION fn_refresh_seller_reputation IS 'Chamar via cron noturno para cada seller ativo.';

-- ------------------------------------------------------------
-- FUNCAO: rank de produto para search (combina TSV + popularidade)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_product_search_rank(
    p_tsv_rank       REAL,
    p_sales          BIGINT,
    p_rating         NUMERIC,
    p_review_count   INT,
    p_recency_days   INT
) RETURNS REAL AS $$
BEGIN
    RETURN (
        COALESCE(p_tsv_rank, 0) * 5.0
        + LEAST(10, LOG(GREATEST(p_sales, 1) + 1)) * 0.8
        + COALESCE(p_rating, 3.5) * 0.4
        + LEAST(5, LOG(GREATEST(p_review_count, 1) + 1)) * 0.3
        - (p_recency_days * 0.001)
    )::REAL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ------------------------------------------------------------
-- FUNCAO: snapshot do produto (para order_items.snapshot)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_product_snapshot(p_product_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_result JSONB;
BEGIN
    SELECT to_jsonb(p) - 'search_tsv' - 'description_html' INTO v_result
      FROM products p WHERE p.id = p_product_id;
    RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE;

-- ------------------------------------------------------------
-- VIEW: produtos publicos otimizados para storefront
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW vw_public_products AS
SELECT
    p.id, p.slug, p.title, p.subtitle, p.short_description,
    p.kind, p.category_id, p.cover_image_url,
    p.price_cents, p.currency, p.license_kind, p.is_free,
    p.tech_stack, p.estimated_install_min,
    p.avg_rating, p.review_count, p.sales_count,
    p.is_platform_owned, p.platform_resale_enabled,
    p.published_at, p.created_at,
    c.slug AS category_slug, c.name AS category_name,
    s.id AS seller_id, s.store_slug, s.store_name,
    s.reputation_tier, s.reputation_score
FROM products p
LEFT JOIN categories c ON c.id = p.category_id
LEFT JOIN sellers s ON s.id = p.seller_id
WHERE p.status = 'approved'
  AND p.deleted_at IS NULL
  AND (p.archived_at IS NULL OR p.archived_at > NOW());

COMMENT ON VIEW vw_public_products IS 'View para listagens publicas. Storefront consome.';

-- ------------------------------------------------------------
-- VIEW: pendencias do seller (Q&A nao respondidas + disputas abertas)
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW vw_seller_pending AS
SELECT
    s.id AS seller_id,
    (SELECT COUNT(*) FROM product_qna q WHERE q.seller_id = s.id AND q.answer IS NULL AND q.is_hidden = FALSE) AS qna_pending,
    (SELECT COUNT(*) FROM disputes d WHERE d.against_seller_id = s.id AND d.status IN ('opened','under_review')) AS disputes_open,
    (SELECT COUNT(*) FROM products p WHERE p.seller_id = s.id AND p.status = 'qa_pending') AS products_in_qa,
    (SELECT COUNT(*) FROM products p WHERE p.seller_id = s.id AND p.status = 'rejected') AS products_rejected,
    (SELECT COUNT(*) FROM product_reviews r WHERE r.seller_id = s.id AND r.reply_at IS NULL AND r.rating <= 3) AS reviews_low_unanswered,
    GREATEST(0, EXTRACT(DAY FROM (s.sla_next_deadline_at - NOW())))::INT AS sla_days_remaining
FROM sellers s
WHERE s.status = 'active';

COMMENT ON VIEW vw_seller_pending IS 'Cards de pendencias no seller dashboard.';

-- ------------------------------------------------------------
-- VIEW: vendas do dia / mes / ano (admin dashboard)
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW vw_platform_revenue AS
SELECT
    DATE_TRUNC('day', o.paid_at) AS day,
    COUNT(*) AS orders_count,
    SUM(o.total_cents) AS gross_cents,
    SUM(oi.commission_cents) AS platform_commission_cents,
    SUM(oi.seller_payout_cents) AS seller_payout_cents,
    SUM(CASE WHEN oi.is_platform_owned THEN oi.line_total_cents ELSE 0 END) AS platform_direct_revenue_cents
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
WHERE o.status IN ('paid','fulfilled')
  AND o.paid_at IS NOT NULL
GROUP BY 1
ORDER BY 1 DESC;

COMMENT ON VIEW vw_platform_revenue IS 'Grafico financeiro principal do admin (vendas diretas vs comissoes).';
