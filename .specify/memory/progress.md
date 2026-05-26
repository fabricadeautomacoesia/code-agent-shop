# progress.md - V1 PUBLICA E2E VALIDADA

## STATUS: PRODUCAO PUBLICA - AGUARDANDO DNS DO USUARIO

### Fluxos E2E validados via HTTPS (Traefik + SSL Lets Encrypt R13)

**Fluxo BUYER:**
1. POST /api/auth/register {role: buyer} -> user criado
2. POST /api/auth/login -> JWT 15min
3. GET /api/auth/me -> user payload com seller_profile=null
4. POST /api/orders/cart/items {product_id, quantity} -> {ok:true}
5. GET /api/orders/cart -> carrinho com items_count, totais
6. POST /api/orders/checkout {payment_method:pix} -> CAS-2026-000001 criado
7. GET /api/orders -> lista pedidos com items_preview

**Fluxo SELLER:**
1. POST /api/auth/register {role: seller} -> user + auto-create seller class_a pending_kyc
2. POST /api/auth/login -> JWT
3. GET /api/sellers/me -> seller_profile completo
4. GET /api/products/me -> [] (correto)

**Endpoints publicos:**
- GET /api/products?limit=N -> 10 produtos demo
- GET /api/products/[slug] -> PDP completo
- GET /api/search?q=whatsapp -> TSVECTOR match
- GET /api/search/categories -> 7 raiz + 18 subcats
- GET /api/aiops/status -> metrics live

**Frontends publicos:**
- https://cas.inovareinteligenciaartificial.com/ -> Mais vendidos + 10 produtos + trending
- https://cas.inovareinteligenciaartificial.com/products -> Lista filtravel
- https://cas.inovareinteligenciaartificial.com/product/[slug] -> PDP
- https://admin.cas.inovareinteligenciaartificial.com -> Sidebar com 10 secoes
- https://seller.cas.inovareinteligenciaartificial.com -> Sidebar com 6 secoes

### Bugs fixed neste sprint
- /products/me retornava 404 (Express route capturava :slug). Reordenado.
- Mesmo bug em /sellers/me e /orders/download. Reordenado.
- Home SSR cached. Forcado dynamic + fetch no-store.

### SSL
- Lets Encrypt R13
- Validade: 2026-05-26 -> 2026-08-24 (auto-renew)

### Login admin
- fabricadeautomacoes0@gmail.com / ChangeMe!2026Inovare

### PENDENCIA: DNS A pelo usuario
- cas.inovareinteligenciaartificial.com -> 209.145.60.53
- api.cas.inovareinteligenciaartificial.com -> 209.145.60.53
- admin.cas.inovareinteligenciaartificial.com -> 209.145.60.53
- seller.cas.inovareinteligenciaartificial.com -> 209.145.60.53
