# Database - Code & Agent Shop

PostgreSQL 16 schema, migracoes idempotentes (CREATE IF NOT EXISTS + DO $$ EXCEPTION $$).

## Ordem de execucao

```
001_extensions_and_enums.sql       # pgcrypto, uuid-ossp, citext, pg_trgm, unaccent + 14 ENUMs
002_users_and_auth.sql             # users, 2fa, sessions, blacklist, password_resets, email_verifications, fail2ban_log, audit_log
003_sellers_and_vault.sql          # sellers (Classe A/B), vault_api_keys (AES-256-GCM), vault_key_usage, seller_sla_history, seller_payouts
004_categories_and_tags.sql        # categories (arvore), tags, category_attributes (filtros facetados)
005_products.sql                   # products, product_versions, product_tags, product_media, product_qa_runs, product_views, product_wishlist
006_orders_and_payments.sql        # carts, cart_items, orders, order_items, asaas_splits, asaas_webhook_events, coupons, coupon_uses
007_engagement_and_reputation.sql  # product_reviews, review_votes, product_qna, reports, disputes, dispute_messages, seller_reputation_history, seller_follows
008_notifications_aiops_search.sql # notifications, notification_templates, user_notification_prefs, metrics_history, alerts, spike_events, search_log, webhook_log, mv_seller_kpi
009_functions_and_views.sql        # fn_calc_reputation_*, fn_refresh_seller_reputation, fn_product_search_rank, vw_public_products, vw_seller_pending, vw_platform_revenue
```

## Seeds

```
seeds/001_seed_categories.sql   # 7 categorias raiz + 18 subcategorias + 13 tags oficiais + 12 templates de notificacao
seeds/002_seed_admin.sql        # Admin user (hash regenerado pelo bin/seed.js no bootstrap)
```

## Comandos

```bash
# Via psql direto (dev local):
psql $DATABASE_URL -f db/migrations/001_extensions_and_enums.sql
psql $DATABASE_URL -f db/migrations/002_users_and_auth.sql
# ... ate 009

# Ou via runner Node (recomendado):
npm run db:migrate          # roda todas as migrations em ordem
npm run db:seed             # roda todos os seeds
npm run db:reset            # DROP DATABASE + CREATE + migrate + seed (DEV ONLY)
npm run db:refresh-views    # REFRESH MATERIALIZED VIEW CONCURRENTLY mv_seller_kpi
```

## Crons internos previstos

| Cron | Frequencia | Acao |
|---|---|---|
| `cron_refresh_reputation`     | diario 03:00 | `fn_refresh_seller_reputation` para cada seller ativo |
| `cron_check_sla_class_b`      | hourly       | Checar deadlines, enviar warnings, revogar quando vencido |
| `cron_cleanup_blacklist`      | hourly       | DELETE FROM token_blacklist WHERE expires_at < NOW() |
| `cron_cleanup_metrics`        | daily 02:00  | DELETE FROM metrics_history WHERE collected_at < NOW() - 30d |
| `cron_backup_pg_dump`         | every 6h     | pg_dump + s3 upload + delete > 7d |
| `cron_refresh_mv_kpi`         | hourly       | REFRESH MATERIALIZED VIEW CONCURRENTLY mv_seller_kpi |
| `cron_release_spike_blocks`   | every 5min   | DELETE FROM spike_events WHERE block_expires_at < NOW() |

## Particionamento futuro (>1M registros)

- `audit_log` - particao mensal por created_at
- `product_views` - particao mensal
- `vault_key_usage` - particao mensal
- `search_log` - particao mensal
- `metrics_history` - particao diaria (alta cardinalidade)

## Backup

`pg_dump $DATABASE_URL | gzip > backups/cas-$(date +%F).sql.gz`
Retencao 7 dias: `find backups/ -mtime +7 -delete`
