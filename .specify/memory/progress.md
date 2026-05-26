# progress.md - V1 COMERCIAL FUNCIONAL + CART DRAWER

## STATUS: SISTEMA COMERCIAL OPERACIONAL - AGUARDANDO DNS

### Funcionalidade comercial completa
- AddToCart funcional no PDP (Comprar agora + Adicionar carrinho + auth redirect)
- CartDrawer lateral global abre via setCartOpen()
- Auto-refresh JWT silencioso em 401
- Cookie cross-subdomain .cas.

### Storefront (16 paginas + componentes globais)
| Componente | Estado |
|---|---|
| Nav scroll-aware | Search modal + 5 links categorias |
| CartDrawer | Lateral, abre via icone cart, lista + remove + total + checkout |
| SearchAutocomplete | Modal global com debounce + trending + ESC |
| HeroAnimated | 4 cards 3D + parallax + glow orb |
| AddToCart | Buy now + Add cart com loading + auth check |
| ProductCard | Com tier badges |
| QnaForm | POST /api/qna |
| Footer | 4 colunas |

### Paginas publicas
1. / (HeroAnimated + Mais vendidos)
2. /products, /product/[slug] (com AddToCart + QnaForm + tabs)
3. /sellers, /seller/[slug]
4. /status (V8 5.3 publica)
5. /login, /register
6. /cart, /checkout
7. /conta, /conta/pedidos, /conta/pedidos/[id], /conta/downloads/[token], /conta/seguranca

### Backend (16 services Swarm UP)
- Gateway com pathRewrite por svc
- 12 svcs Node + qa-worker Python
- 47 tabelas + 10 produtos demo + admin

### Backup pg_dump cron 6h + retencao 7d

### SSL Lets Encrypt R13 auto-renew

### PENDENCIA UNICA: DNS A
- cas, api.cas, admin.cas, seller.cas .inovareinteligenciaartificial.com -> 209.145.60.53
