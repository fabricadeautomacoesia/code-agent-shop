# progress.md - V1 PUBLICA + AUTH CROSS-DOMAIN + Q&A

## STATUS: PRODUCAO PUBLICA E2E COMPLETO - AGUARDANDO DNS

### Auth flow validado (cross-subdomain)
- Cookie cas_rt com Domain=.cas.inovareinteligenciaartificial.com
- Compartilhado entre cas.* e api.cas.*
- Refresh rotation com blacklist do antigo (V8 21.6)

### Fluxos validados em producao
- Buyer: register -> login -> cart -> checkout PIX -> orders list
- Seller: register -> auto-create seller_profile -> /sellers/me OK
- Q&A: POST pergunta -> persiste no DB -> aparece no PDP publico

### Storefront (13 paginas)
- /, /products, /product/[slug] com QnaForm
- /login, /register, /cart, /checkout
- /conta, /conta/pedidos, /conta/pedidos/[id], /conta/downloads/[token], /conta/seguranca

### Admin (9 paginas) + Seller (6 paginas)

### SSL
- Lets Encrypt R13 auto-renew

### PENDENCIA UNICA: DNS A pelo usuario
- cas, api.cas, admin.cas, seller.cas .inovareinteligenciaartificial.com -> 209.145.60.53
