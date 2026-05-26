# progress.md - V1 + MLB-1 + MLB-2 + SEO META 11 PAGES

## STATUS: AUTOMACAO PARALELA + SEO COMPLETO

## SEO Metadata (W9 worker - rodada 1) - VALIDADO
11 paginas com metadata layouts:
- /sellers - "Vendedores"
- /products - "Catalogo Completo"
- /login, /register - publicas
- /esqueci-senha, /redefinir-senha - noindex
- /conta - noindex
- /cart, /checkout - noindex (privado)
- /status - publica
- /categoria/[slug] - DINAMICO (Mais vendidos: <cat>)

Todas com:
- title custom
- description SEO-friendly pt-BR
- openGraph (publicas)
- robots noindex (privadas)

## MLB Features (3 de 11)

### MLB-1: Mais Vendidos por Categoria
- /api/search/top-sellers + /categoria/[slug] + ProductCard badge MAIS VENDIDO

### MLB-2: Q&A com Upvote
- product_qna_votes + POST /qna/:id/upvote toggle + QnaUpvote component
- VALIDADO E2E: 0->1->0 toggle

### MLB-9: Selo OFICIAL MAIS VENDIDO (via MLB-1)
- Badge gradient yellow-orange no card top seller

## FROTA 20 WORKERS ATIVOS (crons paralelos)
W1-W18 + MLB Crawler + Continue meta

## Storefront (27 pages + 11 layouts SEO + 3 UX)
27 paginas publicas + UX defensiva + metadata

## Components globais (13)
+ QnaUpvote + WishlistButton + NotificationBell + HeroAnimated

## Backend 16 services Swarm + Postgres 48 tabelas (+votes)

## Auth + Comercio + Reviews + Q&A + Reports + Wishlist E2E

## SSL Lets Encrypt R13 + Backup pg_dump cron 6h

## PENDENCIA UNICA: DNS A
- cas, api.cas, admin.cas, seller.cas .inovareinteligenciaartificial.com -> 209.145.60.53
