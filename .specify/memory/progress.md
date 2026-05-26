# progress.md - V1 + 8 MLB FEATURES + 20 WORKERS

## STATUS: AUTOMACAO ATIVA + 8 FEATURES MLB (apenas 3 pendentes)

## MLB Features (8 de 11 implementadas)

### MLB-1: Mais Vendidos por Categoria
- /api/search/top-sellers + /categoria/[slug] + badge MAIS VENDIDO

### MLB-2: Q&A com Upvote
- product_qna_votes + POST /qna/:id/upvote + QnaUpvote component

### MLB-3+8: Quantidade vendida em destaque
- Badge "+N vendidos" no PDP

### MLB-6: Recomendacoes Personalizadas (NOVO)
- /api/products/recommendations/for-me (baseado em product_views ultimos 30d)
- /api/products/:slug/related (mesma categoria)
- Secao "Voce tambem pode gostar" no PDP com 6 cards
- VALIDADO HTTP 200 com Chatbot RAG e Multi-Agent retornados

### MLB-7: Comparador de Produtos
- /api/products/compare?ids=X,Y,Z + /comparar page tabular

### MLB-9: Selo OFICIAL MAIS VENDIDO

### MLB-10: Promocao Relampago com Timer
- /api/products/flash-promo/active + FlashPromoTimer + /promocoes

## MLB Pendentes (3 de 11)
- MLB-4 Mercado Pontos / loyalty (tabela criada)
- MLB-5 Mercado Credito (parcelamento)
- MLB-11 Cupom progressivo (tier_breakpoints criado)

## Migration 010 aplicada com colunas/tabelas para futuras MLB

## FROTA 20 WORKERS ATIVA

## Storefront (29 pages publicas) + 12 SEO layouts + 3 UX
## Components globais (14)
## Admin (9) + Seller (8)
## Backend 16 services + Postgres 51 tabelas
## SSL Lets Encrypt R13 + Backup cron 6h

## PENDENCIA UNICA: DNS A pelo usuario
- cas, api.cas, admin.cas, seller.cas .inovareinteligenciaartificial.com -> 209.145.60.53
