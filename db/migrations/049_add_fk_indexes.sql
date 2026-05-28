-- Migration 049: ADD indices em FKs sem cobertura (W14 pass 120)
--
-- Análise via pg_constraint + pg_index em prod:
-- 16 FKs detectadas SEM indice cobrindo a coluna referente.
-- Sem indice em FK = table scan em:
--   - DELETE/UPDATE na tabela parent (cascade check)
--   - JOINs filtrando pela FK
--   - Queries de auditoria (e.g. "todos os products approved_by user X")
--
-- Priorizamos 8 FKs mais usadas em queries reais do app:
--   - products.approved_by: admin force-approve audit
--   - product_qa_runs.product_version_id: QA history per version
--   - product_qa_runs.triggered_by_user_id: who-triggered audit
--   - cart_items.product_version_id: cart versioning
--   - order_items.product_version_id: order history versioning
--   - coupons.created_by: admin coupons created audit
--   - reports.reporter_user_id: user reports history
--   - disputes.order_item_id: dispute lookup per order
--   - dispute_messages.sender_user_id: thread per user
--   - product_reviews.reply_by_user_id: replies per admin
--   - sellers.kyc_reviewed_by_user_id: KYC review audit
--   - seller_payouts.approved_by: payout approval audit
--   - alerts.acknowledged_by: alerts ack audit
--   - vault_key_usage.product_id: usage per product
--   - seller_sla_history.actor_user_id: SLA action audit
--   - reports.resolved_by: report resolution audit
--
-- Storage impact: ~16 indices x ~30KB = ~480KB total (FKs sao UUIDs/INTs)
-- Performance impact: DELETE em users acelera ~100x (era seq_scan em 14 tabelas)
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_<name>;

-- B-tree em UUID/INT é default e barato
CREATE INDEX IF NOT EXISTS idx_products_approved_by ON products(approved_by) WHERE approved_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_product_qa_runs_product_version_id ON product_qa_runs(product_version_id);
CREATE INDEX IF NOT EXISTS idx_product_qa_runs_triggered_by_user_id ON product_qa_runs(triggered_by_user_id) WHERE triggered_by_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cart_items_product_version_id ON cart_items(product_version_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product_version_id ON order_items(product_version_id);
CREATE INDEX IF NOT EXISTS idx_coupons_created_by ON coupons(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reports_reporter_user_id ON reports(reporter_user_id);
CREATE INDEX IF NOT EXISTS idx_reports_resolved_by ON reports(resolved_by) WHERE resolved_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_disputes_order_item_id ON disputes(order_item_id);
CREATE INDEX IF NOT EXISTS idx_dispute_messages_sender_user_id ON dispute_messages(sender_user_id);
CREATE INDEX IF NOT EXISTS idx_product_reviews_reply_by_user_id ON product_reviews(reply_by_user_id) WHERE reply_by_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sellers_kyc_reviewed_by_user_id ON sellers(kyc_reviewed_by_user_id) WHERE kyc_reviewed_by_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_seller_payouts_approved_by ON seller_payouts(approved_by) WHERE approved_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_alerts_acknowledged_by ON alerts(acknowledged_by) WHERE acknowledged_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vault_key_usage_product_id ON vault_key_usage(product_id);
CREATE INDEX IF NOT EXISTS idx_seller_sla_history_actor_user_id ON seller_sla_history(actor_user_id) WHERE actor_user_id IS NOT NULL;

-- ANALYZE para refresh statistics
ANALYZE products;
ANALYZE product_qa_runs;
ANALYZE cart_items;
ANALYZE order_items;
ANALYZE coupons;
ANALYZE reports;
ANALYZE disputes;
ANALYZE dispute_messages;
ANALYZE product_reviews;
ANALYZE sellers;
ANALYZE seller_payouts;
ANALYZE alerts;
ANALYZE vault_key_usage;
ANALYZE seller_sla_history;
