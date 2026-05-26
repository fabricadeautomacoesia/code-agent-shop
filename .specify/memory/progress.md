# progress.md - V1 PUBLICA COMPLETA + STATUS PAGE

## STATUS: PRODUCAO READY - AGUARDANDO DNS

### Storefront (16 pages publicas)
| Pagina | Tipo |
|---|---|
| / | SSR Home com HeroAnimated 3D + Mais vendidos + Trending |
| /products | Lista filtravel paginada |
| /product/[slug] | PDP com QnaForm + tabs + sticky sidebar |
| /sellers | Lista de vendedores ativos com filtros |
| /seller/[slug] | Loja publica do vendedor |
| /status | Status page ao vivo (CPU/RAM/Disk + services + alerts) |
| /login | Com fluxo 2FA |
| /register | Com barra forca de senha |
| /cart, /checkout | PIX QR + Boleto + Cartao |
| /conta | Perfil + 4 cards |
| /conta/pedidos | Lista com cover thumbnails |
| /conta/pedidos/[id] | Detalhe com license keys |
| /conta/downloads/[token] | Download seguro |
| /conta/seguranca | 2FA TOTP setup + recovery codes |

### Componentes globais
- Nav (sticky scroll-aware) com SearchAutocomplete modal (debounce + trending + ESC)
- HeroAnimated (4 cards 3D + parallax mouse + glow orb GSAP)
- ProductCard com tier badges
- QnaForm reusavel
- Footer com 4 colunas

### Backend (16 services Swarm)
- Gateway com pathRewrite por svc + Swarm DNS upstreams
- Auth com JWT 15min + refresh 7d + rotation + blacklist + 2FA TOTP
- Cookie cross-subdomain (.cas.) + auto-refresh silencioso

### Backup automatizado (V8 6.2)
- /opt/cas/deploy/cron-backup.sh ativo
- Cron 0 */6 * * *
- Retencao 7d, 47KB por dump

### SSL Lets Encrypt R13 auto-renew

### PENDENCIA UNICA: DNS A
- cas, api.cas, admin.cas, seller.cas .inovareinteligenciaartificial.com -> 209.145.60.53
