# progress.md - V1 + MIGRATION 010 + 4 FEATURES MLB

## STATUS: AUTOMACAO ATIVA + 4 MLB FEATURES + DB EXPANDIDO

## Migration 010 aplicada (W14)
- product_qna_votes (consolidada)
- products: flash_promo_active/discount_pct/ends_at, last_sale_at
- Indices: idx_products_flash_promo, idx_products_cat_sales, idx_wishlist_product
- coupons.tier_breakpoints (JSONB)
- user_loyalty + loyalty_transactions
- product_compare_sessions

## MLB Features (4 de 11)

### MLB-1: Mais Vendidos por Categoria
- /api/search/top-sellers + /categoria/[slug] + badge MAIS VENDIDO

### MLB-2: Q&A com Upvote
- product_qna_votes + POST /qna/:id/upvote toggle + QnaUpvote component E2E

### MLB-3+8: Quantidade vendida em destaque (NOVO)
- Badge verde "+N vendidos" no PDP (Mercado Livre social proof)
- Arredondamento para baixo em 10 (ex: 523 vendas -> "+520 vendidos")
- Aparece apenas se sales_count > 50

### MLB-9: Selo OFICIAL MAIS VENDIDO (via MLB-1)

## Bug critico corrigido (W3 worker)
- PDP retornava 404 server error: QnaUpvote is not defined (import faltando)
- Fix: import { QnaUpvote } adicionado, PDP voltou a renderizar

## FROTA 20 WORKERS ATIVOS

## Storefront (27 pages + 11 layouts SEO + 3 UX)
## Components (13) + QnaUpvote
## Admin (9) + Seller (8)
## Backend 16 services + Postgres 51 tabelas (3 novas em 010)
## SSL + Backup

## PENDENCIA UNICA: DNS A
- cas, api.cas, admin.cas, seller.cas .inovareinteligenciaartificial.com -> 209.145.60.53
