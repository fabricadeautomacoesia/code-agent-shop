-- Migration 063: fn_refresh_all_seller_reputations bulk set-based function
-- W14 pass 210 - 2026-05-28
--
-- CONTEXTO:
-- fn_refresh_seller_reputation(p_seller_id) (mig 009) executa 6 queries
-- por seller. Cron noturno em review-svc/server.js itera N sellers ->
-- O(N * 6) queries = 6000+ em prod com 1000 sellers.
--
-- Loop cron typical em prod:
--   sellers = 1000 (active + nao deletado)
--   queries = 6000+ (6 per seller) + 1 REFRESH MV
--   duration: ~30-60s typical (depende de carga PG)
--
-- DESIGN BULK SET-BASED:
-- - 5 CTEs aggregam metricas via GROUP BY seller_id (1 query cada)
-- - 1 UPDATE sellers ... FROM aggregates JOIN seller_id
-- - 1 INSERT seller_reputation_history ... FROM aggregates JOIN
-- - Total: 7 queries (vs 6000) - reducao 99.88%
--
-- TRADE-OFF: bulk function executa TODA atualizacao em 1 tx longa.
-- Cron noturno 3:03 AM = OK. Live admin trigger (pass 208) usa
-- bulk vs per-seller? Pass 208 endpoint usa REFRESH MATERIALIZED VIEW
-- direto (sem chamar fn_refresh_all*) - independent.
--
-- FUTURO: per-seller function pode ser deprecated apos validar bulk em prod
-- (manter por enquanto p/ caso edge-case admin reset 1 seller manual).

CREATE OR REPLACE FUNCTION fn_refresh_all_seller_reputations()
RETURNS TABLE(seller_count INT, duration_ms INT) AS $$
DECLARE
  v_start TIMESTAMPTZ := clock_timestamp();
  v_seller_count INT;
BEGIN
  -- 1. CTE bulk: agregacao metricas all sellers ativos numa unica passada
  -- Strategy: 5 LEFT JOINs lateral em sellers WHERE active.
  -- Output: 1 row per seller com sales/rating/dispute_count/avg_response/sla
  -- + escolhe tier + score via funcoes existentes (fn_calc_*)
  WITH active_sellers AS (
    SELECT id, seller_class, sla_revoked_count
      FROM sellers
     WHERE status = 'active' AND deleted_at IS NULL
  ),
  sales_agg AS (
    SELECT oi.seller_id, COUNT(DISTINCT oi.order_id)::BIGINT AS v_sales
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
     WHERE oi.seller_id IN (SELECT id FROM active_sellers)
       AND o.status IN ('paid','fulfilled')
     GROUP BY oi.seller_id
  ),
  reviews_agg AS (
    SELECT seller_id, AVG(rating)::NUMERIC AS v_avg_rating, COUNT(*)::INT AS v_review_count
      FROM product_reviews
     WHERE seller_id IN (SELECT id FROM active_sellers)
       AND is_hidden = FALSE
     GROUP BY seller_id
  ),
  disputes_agg AS (
    SELECT against_seller_id AS seller_id, COUNT(*)::INT AS v_dispute_count
      FROM disputes
     WHERE against_seller_id IN (SELECT id FROM active_sellers)
     GROUP BY against_seller_id
  ),
  qna_agg AS (
    SELECT seller_id, AVG(EXTRACT(EPOCH FROM (answered_at - asked_at))/3600)::NUMERIC AS v_avg_response_h
      FROM product_qna
     WHERE seller_id IN (SELECT id FROM active_sellers)
       AND answered_at IS NOT NULL
     GROUP BY seller_id
  ),
  computed AS (
    SELECT s.id AS seller_id,
           COALESCE(sa.v_sales, 0) AS v_sales,
           ra.v_avg_rating,
           COALESCE(ra.v_review_count, 0) AS v_review_count,
           COALESCE(da.v_dispute_count, 0) AS v_dispute_count,
           CASE WHEN COALESCE(sa.v_sales, 0) > 0
                THEN COALESCE(da.v_dispute_count, 0)::NUMERIC / sa.v_sales
                ELSE 0 END AS v_dispute_rate,
           qa.v_avg_response_h,
           CASE
             WHEN s.seller_class = 'class_b' AND s.sla_revoked_count > 0 THEN 0.5
             WHEN s.seller_class = 'class_b' THEN 1.0
             ELSE 1.0
           END AS v_sla_compliance
      FROM active_sellers s
      LEFT JOIN sales_agg sa ON sa.seller_id = s.id
      LEFT JOIN reviews_agg ra ON ra.seller_id = s.id
      LEFT JOIN disputes_agg da ON da.seller_id = s.id
      LEFT JOIN qna_agg qa ON qa.seller_id = s.id
  ),
  scored AS (
    SELECT seller_id, v_sales, v_avg_rating, v_review_count, v_dispute_rate,
           v_avg_response_h, v_sla_compliance,
           fn_calc_reputation_score(v_sales, v_avg_rating, v_review_count,
                                    v_dispute_rate, v_avg_response_h, v_sla_compliance) AS v_score,
           fn_calc_reputation_tier(v_sales) AS v_tier
      FROM computed
  ),
  -- 2. UPDATE sellers SET ... FROM scored em bulk
  upd AS (
    UPDATE sellers s
       SET total_sales      = sc.v_sales,
           avg_rating       = sc.v_avg_rating,
           reputation_score = sc.v_score,
           reputation_tier  = sc.v_tier,
           updated_at       = NOW()
      FROM scored sc
     WHERE s.id = sc.seller_id
    RETURNING s.id
  ),
  -- 3. INSERT seller_reputation_history bulk com ON CONFLICT
  hist AS (
    INSERT INTO seller_reputation_history(
        seller_id, snapshot_date, tier, score, total_sales,
        avg_rating, review_count, dispute_rate, avg_response_time_hours, sla_compliance_pct
    )
    SELECT seller_id, CURRENT_DATE, v_tier, v_score, v_sales,
           v_avg_rating, v_review_count, v_dispute_rate, v_avg_response_h, v_sla_compliance
      FROM scored
    ON CONFLICT (seller_id, snapshot_date) DO UPDATE
       SET tier = EXCLUDED.tier, score = EXCLUDED.score,
           total_sales = EXCLUDED.total_sales, avg_rating = EXCLUDED.avg_rating,
           review_count = EXCLUDED.review_count, dispute_rate = EXCLUDED.dispute_rate
    RETURNING seller_id
  )
  SELECT COUNT(*)::INT INTO v_seller_count FROM upd;

  RETURN QUERY SELECT
    v_seller_count,
    EXTRACT(MILLISECONDS FROM (clock_timestamp() - v_start))::INT;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION fn_refresh_all_seller_reputations IS
  'W14-pass210: bulk set-based REFRESH all active sellers. Substitui loop O(N*6) por O(7) queries. Cron noturno 3:03 AM consume.';

-- ROLLBACK:
--   DROP FUNCTION IF EXISTS fn_refresh_all_seller_reputations();
--   (fn_refresh_seller_reputation per-seller mantida para edge cases)

DO $$
BEGIN
  RAISE NOTICE 'W14-pass210: fn_refresh_all_seller_reputations() criada (bulk set-based)';
END $$;
