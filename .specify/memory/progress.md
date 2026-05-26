# progress.md - V1 + WISHLIST + CRON MLB

## STATUS: SISTEMA OPERACIONAL + AUTOMACAO DE FEATURES

### Wishlist E2E (NOVO)
- POST /api/products/wishlist {product_id}
- DELETE /api/products/wishlist/:product_id
- GET /api/products/wishlist (lista do user)
- GET /api/products/wishlist/:id/check (esta favoritado?)
- VALIDADO em producao

### Componentes novos
- WishlistButton no PDP (toggle + Heart fill animado)
- /conta/favoritos (grid com ProductCard dos favoritados)

### CRONS ATIVOS
1. **0f7dfeb9** - a cada 4min - continuar trabalho do projeto
2. **47bc7572** (NOVO) - a cada 12min - analisar Mercado Livre + implementar feature + deploy

   Features-alvo identificadas (1 por cron):
   - Q&A com upvote
   - Mercado Pontos/loyalty
   - Mais vendidos por categoria
   - Recomendacoes personalizadas (product_views ja existe)
   - Comparador de produtos
   - Quantidade vendida em destaque
   - Selo OFICIAL MAIS VENDIDO
   - Promocoes relampago com timer
   - Cupom progressivo

### Storefront (26 pages: 22 + 3 UX + favoritos)
- + /conta/favoritos

### Componentes globais (12)
Nav, Footer, Providers, CartDrawer, AddToCart, ReviewForm, QnaForm,
SearchAutocomplete, HeroAnimated, ProductCard, NotificationBell, **WishlistButton**

### Admin (9) + Seller (8)

### Backend (16 services Swarm UP)
- product-svc com /uploads + /wishlist
- 47 tabelas + Redis + volume persistente

### Auth + Comercio + Relacionamento + SEO + Legal completos

### PENDENCIA UNICA: DNS A
- cas, api.cas, admin.cas, seller.cas .inovareinteligenciaartificial.com -> 209.145.60.53
