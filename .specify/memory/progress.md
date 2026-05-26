# progress.md - V1 + 10 MLB FEATURES + 20 WORKERS

## STATUS: AUTOMACAO ATIVA + 10 FEATURES MLB (apenas 1 pendente)

## MLB Features (10 de 11 implementadas)

### MLB-1: Mais Vendidos por Categoria
- /api/search/top-sellers + /categoria/[slug] + badge MAIS VENDIDO

### MLB-2: Q&A com Upvote
- product_qna_votes + POST /qna/:id/upvote + QnaUpvote component

### MLB-3+8: Quantidade vendida em destaque
- Badge "+N vendidos" no PDP

### MLB-4: Mercado Pontos / Loyalty (E2E VALIDADO)
- /api/loyalty/me + /api/loyalty/earn (gateway -> seller-svc)
- /conta/pontos com tier card gradient, progress bar, 3 benefits, historico
- Cards "CAS Pontos" + "Favoritos" no /conta dashboard
- Welcome bonus 100 pts na primeira visita /loyalty/me
- Earn hook em payment-svc webhook PAYMENT_RECEIVED/CONFIRMED:
  - 1 ponto por R$ 1 do total_cents do pedido
  - multiplicador automatico: Gold +20%, Platinum +50%
  - recalculo de tier automatico

### MLB-6: Recomendacoes Personalizadas
- /api/products/recommendations/for-me (baseado em product_views ultimos 30d)
- /api/products/:slug/related (mesma categoria)
- Secao "Voce tambem pode gostar" no PDP com 6 cards

### MLB-7: Comparador de Produtos
- /api/products/compare?ids=X,Y,Z + /comparar page tabular

### MLB-9: Selo OFICIAL MAIS VENDIDO

### MLB-10: Promocao Relampago com Timer
- /api/products/flash-promo/active + FlashPromoTimer + /promocoes

### MLB-11: Cupom Progressivo (NOVO - E2E VALIDADO)
- coupons.tier_breakpoints JSONB: [{"min_cents":N,"discount_value":N}, ...]
- order-svc.recalcCart escolhe maior tier alcancado pelo subtotal
- GET /orders/cart/coupon/:code/preview?subtotal_cents=N
  retorna tiers ordenados + active_tier_index + next_tier + discount_cents
- /cart page exibe card "CUPOM PROGRESSIVO" com lista de tiers,
  tier ativo destacado, e CTA "adicione mais R$X para -Y%"
- Cupom seed PROGRESSIVO15: 5%/10%/15% nos breakpoints R$100/R$300/R$800
- VALIDADO 4 subtotais via curl: R$50/R$150/R$500/R$1000 -> tiers -1/0/1/2 corretos

## MLB Pendentes (1 de 11)
- MLB-5 Mercado Credito (parcelamento) - infraestrutura Asaas ja disponivel

## Migration 010 aplicada com colunas/tabelas para futuras MLB

## FROTA 20 WORKERS ATIVA

## Storefront (29 pages publicas) + 12 SEO layouts + 3 UX
## Components globais (14)
## Admin (9) + Seller (8)
## Backend 16 services + Postgres 51 tabelas
## SSL Lets Encrypt R13 + Backup cron 6h

## PENDENCIA UNICA: DNS A pelo usuario
- cas, api.cas, admin.cas, seller.cas .inovareinteligenciaartificial.com -> 209.145.60.53
