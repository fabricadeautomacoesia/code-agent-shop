# progress.md - V1 + 5 MLB FEATURES + 20 WORKERS

## STATUS: AUTOMACAO ATIVA + 5 FEATURES MLB IMPLEMENTADAS

## MLB Features (5 de 11)

### MLB-1: Mais Vendidos por Categoria
- /api/search/top-sellers + /categoria/[slug] + badge MAIS VENDIDO

### MLB-2: Q&A com Upvote
- product_qna_votes + POST /qna/:id/upvote toggle + QnaUpvote component

### MLB-3+8: Quantidade vendida em destaque
- Badge verde "+N vendidos" no PDP (Mercado Livre social proof)

### MLB-9: Selo OFICIAL MAIS VENDIDO (via MLB-1)

### MLB-10: Promocao Relampago com Timer (NOVO)
- /api/products/flash-promo/active endpoint
- FlashPromoTimer component (countdown dd hh mm ss real-time)
- /promocoes page com produtos em desconto
- Nav link "Promocoes" laranja
- 3 produtos demo com 25% OFF por 24h
- VALIDADO HTTP 200 + "Termina em" + "Agente WhatsApp"

## MLB Pendentes (6 de 11)
- Mercado Pontos / loyalty (tabela ja existe)
- Mercado Credito (parcelamento)
- Recomendacoes personalizadas (product_views)
- Comparador (tabela ja existe)
- Cupom progressivo (tier_breakpoints ja existe)
- + 1 outra

## Migration 010 aplicada
+ flash_promo_active/discount/ends_at + last_sale_at + loyalty + compare + tier_breakpoints

## FROTA 20 WORKERS ATIVA

## Storefront (28 pages publicas + 12 SEO layouts + 3 UX)
+ /promocoes

## Components (14) + FlashPromoTimer

## Admin (9) + Seller (8)

## Backend 16 services + Postgres 51 tabelas

## SSL Lets Encrypt R13 + Backup cron 6h

## PENDENCIA UNICA: DNS A
- cas, api.cas, admin.cas, seller.cas .inovareinteligenciaartificial.com -> 209.145.60.53
