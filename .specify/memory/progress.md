# progress.md - V1 + 11 MLB FEATURES COMPLETAS + 20 WORKERS

## STATUS: MARCO ALCANCADO - 11 de 11 MLB FEATURES IMPLEMENTADAS E VALIDADAS

## MLB Features (11 de 11 - 100%)

### MLB-1: Mais Vendidos por Categoria
- /api/search/top-sellers + /categoria/[slug] + badge MAIS VENDIDO

### MLB-2: Q&A com Upvote
- product_qna_votes + POST /qna/:id/upvote + QnaUpvote component

### MLB-3+8: Quantidade vendida em destaque
- Badge "+N vendidos" no PDP

### MLB-4: Mercado Pontos / Loyalty (E2E VALIDADO)
- /api/loyalty/me + /api/loyalty/earn (gateway -> seller-svc)
- /conta/pontos + Cards "CAS Pontos"/"Favoritos" no /conta
- Welcome bonus 100 pts; earn hook em payment-svc webhook
- 1pt/R$1 com multiplicador Gold +20% / Platinum +50%

### MLB-5: Mercado Credito / Parcelamento (NOVO - E2E VALIDADO)
- payment-svc.createPayment com installmentCount + installmentValue (Asaas split-friendly)
- GET /api/payments/installments/preview?amount_cents=N&max=12 retorna 1-12x
  - 1-3x sem juros (min R$5/parcela)
  - 4-12x juros compostos 2.99%a.m. (min R$10/parcela)
  - retorna {count, per_cents, first_cents, total_cents, interest_pct, label}
- order-svc.checkout zod aceita installment_count + forwarda para payment-svc via UPSTREAM_PAYMENT (tasks.cas_payment-svc no Swarm)
- /checkout UI: grid de parcelas highlight verde (sem juros) vs laranja (com juros)
- VALIDADO 5 amounts (R$50/R$500/R$1k/R$5k/R$10k) - tabela completa de juros gerada corretamente

### MLB-6: Recomendacoes Personalizadas
- /api/products/recommendations/for-me + /api/products/:slug/related
- Secao "Voce tambem pode gostar" no PDP com 6 cards

### MLB-7: Comparador de Produtos
- /api/products/compare?ids=X,Y,Z + /comparar page tabular com matriz de tech_stack

### MLB-9: Selo OFICIAL MAIS VENDIDO

### MLB-10: Promocao Relampago com Timer
- /api/products/flash-promo/active + FlashPromoTimer + /promocoes

### MLB-11: Cupom Progressivo (E2E VALIDADO)
- coupons.tier_breakpoints JSONB com array de {min_cents, discount_value}
- order-svc.recalcCart escolhe maior tier alcancado
- GET /api/orders/cart/coupon/:code/preview?subtotal_cents=N
- /cart page com card "CUPOM PROGRESSIVO" + tiers + CTA "adicione mais X para -Y%"
- Cupom seed PROGRESSIVO15: 5%/10%/15% em R$100/R$300/R$800

## Migration 010 com colunas tier_breakpoints, flash_promo_*, etc

## INFRA ESTAVEL EM PRODUCAO
- 16 microsservicos Node.js + qa-worker Python no Docker Swarm
- Postgres 51 tabelas + 16 indices criticos
- Storefront (29 pages publicas) + 12 SEO layouts + 14 componentes globais
- Admin (9 pages) + Seller (8 pages) com endpoints reais
- SSL Lets Encrypt R13 + Backup cron 6h
- 20 cron workers paralelos para auto-fix continuo

## SEO HARDENING (WORKER 9 - PASS 1)
- /product/[slug] agora tem generateMetadata dinamica:
  title "Nome do produto - R$X | Code & Agent Shop"
  description short_description/description strip HTML 160 chars
  canonical + openGraph type=website + twitter summary_large_image + robots index/follow
- /seller/[slug] generateMetadata:
  title "Loja - Vendedor | Code & Agent Shop"
  description "Loja oficial X. N vendas - M produtos. Tier Y."
  canonical + openGraph type=profile + twitter card + robots index/follow
- VALIDADO HTML servido publicamente contem og:title, og:image, og:type, canonical e twitter:card corretos

## PENDENCIA UNICA: DNS A pelo usuario
- cas, api.cas, admin.cas, seller.cas .inovareinteligenciaartificial.com -> 209.145.60.53
- Sistema 100% acessivel via Host header (curl --resolve) ate la
