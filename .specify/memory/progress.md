# progress.md - V1 + MLB-1 + MLB-2 + 20 WORKERS

## STATUS: AUTOMACAO ATIVA + FEATURES MLB IMPLEMENTADAS

## MLB Features implementadas (2 de 11)

### MLB-1: Mais Vendidos por Categoria
- /api/search/top-sellers (agrupado) + /:category (lista)
- /categoria/[slug] page com badges 1o/2o/3o
- ProductCard com badge MAIS VENDIDO
- Home com chips de top por categoria
- VALIDADO: HTTP 200

### MLB-2: Q&A com Upvote (NOVO)
- Tabela product_qna_votes (qna_id, user_id)
- POST /api/qna/:id/upvote (toggle on/off)
- GET /api/qna/:id/voted (check)
- QnaUpvote component com ChevronUp + count
- Integrado no PDP ao lado de cada pergunta
- VALIDADO E2E: 0 -> 1 -> 0 toggle

## MLB Features pendentes (9 de 11)
- Mercado Pontos / loyalty
- Mercado Credito (parcelamento)
- Recomendacoes personalizadas (product_views existe)
- Comparador de produtos
- Quantidade vendida em destaque PDP
- Promocoes relampago com timer
- Cupom de desconto progressivo
- + 2 outras

## FROTA 20 WORKERS ATIVA
- W1-W18 + MLB Crawler + Continue
- Workers corrigindo bugs e implementando features em paralelo

## Storefront (27 pages publicas) + 12 components globais
## Admin (9) + Seller (8)
## Backend 16 services Swarm + Postgres 48 tabelas (+votes)
## SSL Lets Encrypt R13 + Backup cron 6h

## PENDENCIA UNICA: DNS A pelo usuario
- cas, api.cas, admin.cas, seller.cas .inovareinteligenciaartificial.com -> 209.145.60.53
