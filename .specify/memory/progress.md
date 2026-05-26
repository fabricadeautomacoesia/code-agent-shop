# progress.md - V1 + 7 MLB FEATURES + 20 WORKERS

## STATUS: AUTOMACAO ATIVA + 7 FEATURES MLB

## MLB Features (7 de 11 implementadas)

### MLB-1: Mais Vendidos por Categoria
- /api/search/top-sellers + /categoria/[slug] + badge MAIS VENDIDO

### MLB-2: Q&A com Upvote
- product_qna_votes + POST /qna/:id/upvote toggle + QnaUpvote component

### MLB-3+8: Quantidade vendida em destaque
- Badge verde "+N vendidos" no PDP

### MLB-7: Comparador de Produtos (NOVO)
- /api/products/compare?ids=X,Y,Z (max 4)
- /comparar page com tabela lateral fixa
- Linhas: Preco, Avaliacao, Vendas, Categoria, Tipo, Vendedor, Instalacao + matriz tech_stack
- Badges flash_promo + Oficial CAS por coluna
- VALIDADO HTTP 200

### MLB-9: Selo OFICIAL MAIS VENDIDO (via MLB-1)

### MLB-10: Promocao Relampago com Timer
- /api/products/flash-promo/active + FlashPromoTimer countdown + /promocoes

## MLB Pendentes (4 de 11)
- MLB-4 Mercado Pontos / loyalty (tabela criada)
- MLB-5 Mercado Credito (parcelamento)
- MLB-6 Recomendacoes personalizadas (product_views existe)
- MLB-11 Cupom progressivo (tier_breakpoints existe)

## Migration 010 aplicada (W14)
+ votes + flash_promo + last_sale + loyalty + compare_sessions + tier_breakpoints

## FROTA 20 WORKERS ATIVA

## Storefront (29 pages publicas) + 12 SEO layouts + 3 UX
+ /promocoes + /comparar

## Components globais (14)

## Admin (9) + Seller (8)

## Backend 16 services Swarm + Postgres 51 tabelas

## SSL Lets Encrypt R13 + Backup cron 6h

## PENDENCIA UNICA: DNS A pelo usuario
- cas, api.cas, admin.cas, seller.cas .inovareinteligenciaartificial.com -> 209.145.60.53
