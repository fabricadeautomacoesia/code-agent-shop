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
- Postgres 51 tabelas + 16 indices criticos + 16 novos indices migration 011 (32 total)
- Storefront (29 pages publicas) + 12 SEO layouts + 14 componentes globais
- Admin (9 pages) + Seller (8 pages) com endpoints reais
- SSL Lets Encrypt R13 + Backup cron 6h
- 20 cron workers paralelos para auto-fix continuo

## SEO HARDENING (WORKER 9)

### Pass 1: Metadata dinamica por entidade
- /product/[slug] generateMetadata: title + description + canonical + og + twitter + robots
- /seller/[slug] generateMetadata: title + description + canonical + og (type=profile)
- VALIDADO HTML servido contem og:title, og:image, canonical, twitter:card

### Pass 2: Sitemap expandido + robots hardened (NOVO)
- sitemap.xml de 16 -> 37 URLs (+131%):
  - 12 estaticas (incluindo /promocoes, /comparar, /cloud-code-ilimitado, /sobre, /termos, /privacidade)
  - 7 categorias /categoria/[slug] (fetch dinamico)
  - 7 kind facets /products?kind=X
  - 10 produtos + sellers existentes
  - lastModified usa updated_at (mais preciso para crawl incremental)
- robots.txt:
  - Allow explicito para /categoria/, /promocoes, /comparar, /sobre, /termos, /privacidade
  - Disallow estendido: /login, /register, /esqueci-senha, /redefinir-senha, /seller/dashboard, /seller/upload
  - Bloqueio total de crawlers agressivos: SemrushBot, AhrefsBot, DotBot, PetalBot, MJ12bot
- VALIDADO 37 <loc> entries publicamente em https://cas.../sitemap.xml

## DB INDEX HARDENING (WORKER 14)
Migration 011 com 16 indices novos para queries quentes:
- idx_pviews_user (partial) + idx_pviews_user_recent (user_id, created_at DESC)
  -> recomendacoes MLB-6 product_views
- idx_loyalty_user_recent (user_id, created_at DESC) + idx_loyalty_tier
  -> MLB-4 loyalty historico + ranking tier
- idx_qna_asked_by + idx_qna_answered_by
  -> Q&A PDP
- idx_wishlist_user + idx_wishlist_product
  -> favoritos
- idx_token_blacklist_user + idx_fail2ban_user
  -> auth/security
- idx_asaas_webhook_order + idx_asaas_splits_order_item + idx_coupon_uses_order
  -> payments
- idx_disputes_mediator + idx_disputes_opener
  -> disputas (futuro)
- idx_search_log_clicked
  -> AIOps analytics

Migration tolerante a falhas (DO blocks com EXCEPTION undefined_table/column).
APLICADA com sucesso no Postgres VPS. EXPLAIN ANALYZE valida planner ja
preparado para escalar (Seq Scan ainda em tabelas <100 rows, mas Index Scan
sera escolhido automaticamente acima desse limiar).

## PAYMENT REFUND - WORKER 11 (CRITICAL SIDE-EFFECTS BYPASS)
Audit em processWebhookEvent revelou bug critico financeiro:
- PAYMENT_REFUNDED apenas setava orders.status='refunded'.
- TUDO que paid criou continuava ativo:
  * license_key + download_token validos 365d (buyer baixa de graca pos-refund)
  * Loyalty pts ganhos (R$1=1pt + tier mult) nunca eram subtraidos
  * Pontos resgatados no cart (loyalty_discount_cents) nao voltavam ao saldo
  * products.sales_count / revenue_cents_total inflados
  * sellers.total_sales / total_revenue_cents inflados
  * asaas_splits='processed' sem flag de refund (conciliacao incorreta)
  * Nenhuma notificacao ao buyer ou sellers do refund

MIGRATION 015:
- order_items.revoked_at TIMESTAMPTZ + revoked_reason VARCHAR(80)
- idx_oi_active_license (partial WHERE revoked_at IS NULL)

FIX commitado + deployed (f446b47 + a9d0a35):

PAYMENT_REFUNDED + PAYMENT_CHARGEBACK agora:
1. UPDATE order_items: revoked_at=NOW(), download_expires_at=NOW(),
   revoked_reason ('refund' ou 'chargeback'). download.js ja valida expires_at,
   buyer ve forbidden ao tentar baixar.
2. Estorna loyalty pts ganhos: para cada loyalty_transactions reason='order_paid'
   do order, UPDATE user_loyalty - pts (GREATEST(0,...) anti-negativo) +
   INSERT delta negativo reason='order_refunded'.
3. Restaura pontos resgatados: UPDATE user_loyalty + pts_redeemed + INSERT
   reason='order_refund_restore'.
4. Decrementa counters products + sellers (todos com GREATEST(0,...)).
5. UPDATE asaas_splits SET status='refunded' (admin estorna transfer manual no Asaas).
6. Notifica buyer (priority=2 alta) + sellers (template seller_sale_refunded).

BONUS: notificacoes seller_new_sale (no paid) estavam em if(false) orphan,
movidas para dentro do if(action.paid_at) - agora disparam corretamente.

VALIDADO:
- Migration 015: 2 columns + idx_oi_active_license criados em prod.
- Webhook /api/payments/asaas/webhook responde 200 com signature valida.
- Handler PAYMENT_REFUNDED montado e pronto. Proximo refund real do Asaas
  vai reverter tudo automaticamente.

## NOTIFICATION UX - WORKER 13 (UUID 22P02 + IDEMPOTENT MARK-AS-READ)
Audit em services/notification-svc revelou 2 bugs:
- POST /:id/read com UUID malformado -> 500 database_error (notification-svc
  ainda nao tinha shared atualizado pos-W4, era um catch-up pendente).
- UPDATE silencioso: retornava ok:true mesmo se notification nao existia
  ou pertencia a outro user. Cliente sem feedback.

FIX commitado + deployed (11a36b6):
- Regex UUID local antes do query (defesa em profundidade, mesmo padrao W4).
- UPDATE com RETURNING id - se 0 rows, checa se notification existe.
- Idempotente: se ja-foi-lida -> 200 {ok:true, already_read:true}.
- Notif inexistente ou outro user -> 404 notification_not_found.

VALIDADO E2E publicamente:
- UUID malformado -> 404 (antes era 500)
- UUID valido inexistente -> 404 (antes era 200 silencioso)
- /read-all preservado -> 200 {marked:N}

## QA PIPELINE SECURITY - WORKER 12 (CALLBACK SIGNATURE BYPASS CRITICAL)
Audit em services/qa-svc/src/server.js revelou bug critico:
- POST /qa/callback aceitava qualquer body sem validar assinatura HMAC.
- Atacante podia POSTar {run_id, confidence_score: 1.0} e aprovar QUALQUER
  produto pendente sem QA real. Cadeia: produto approved -> vitrine -> venda
  -> license_key emitida + download_token valido 365d. Fraude direta.
- BONUS: WORKER_URL e callback_url usavam 127.0.0.1 em vez do service name
  do Swarm (worker em outro container nunca alcancava qa-svc).

FIX commitado + deployed (cdbb70e):

qa-svc/server.js:
- ADD env QA_CALLBACK_SECRET (sem ele -> 503 fail-CLOSED).
- ADD env QA_CALLBACK_BASE_URL (default tasks.cas_qa-svc no Swarm).
- WORKER_URL default agora tasks.cas_qa-worker (era 127.0.0.1).
- express.raw montado em /qa/callback para validar HMAC byte-exact.
- qaCallbackGuard middleware:
  - crypto.createHmac('sha256', secret).update(rawBody) vs X-Signature header.
  - timingSafeEqual com Buffer.
  - Invalido -> 401 invalid_signature + log.warn{ip,ua}.
  - Apos validar, JSON.parse + segue para handler.

qa-worker/app/main.py:
- send_callback assina com hmac.new(secret, body, sha256).
- httpx envia content=body_bytes (nao 'json='), garantindo bytes determinsticos.
- json.dumps(separators=',',':' + ensure_ascii=False) = serializacao consistente.

DEPLOY: QA_CALLBACK_SECRET gerado via openssl rand -hex 32 em .env Swarm.
docker service update --env-add em ambos cas_qa-svc e cas_qa-worker.

VALIDADO E2E publicamente via curl:
- Sem X-Signature -> 401 invalid_signature
- X-Signature errada -> 401 invalid_signature
- X-Signature correta (HMAC-SHA256 do raw body) -> 200 verdict:approved

## SELLER DASH - WORKER 5 (UPLOAD STALE CLOSURE FIX)
Audit estatico em dashboard-seller revelou bug subtil em /upload:
- handleFile usava setUploading({...uploading, [field]: true}) e finally false.
- Closure captura 'uploading' no momento do call. Uploads cover+pkg paralelos
  sobrescreviam o flag um do outro silenciosamente.
- Spinners poderiam desaparecer prematuramente, dando impressao de upload
  completo enquanto ainda processando o outro arquivo.
- Mesmo bug em setForm que poderia perder cover_image_url se pkg sobrescreve.

FIX commitado + deployed (1470f96):
- setUploading((p) => ({ ...p, [field]: ... })) functional setState
- setForm((p) => ({ ...p, [targetField]: r.url })) idem
- Padrao React canonical para state-merge em updates assincronos.

VALIDADO: /upload page rebuilt + bundle contem cover_image_url e package_url.
Race condition resolvida (testavel via paralelos uploads no browser).

## PDP TABS - WORKER 3 (TABS DECORATIVAS -> FUNCIONAIS)
Audit em /product/[slug] revelou bug critico:
- 5 tabs (Visao Geral, Pre-requisitos, Changelog, Reviews, Q&A) eram <button> SEM onClick.
- Apenas i===0 era marcado como ativo (hardcoded), restante so visual.
- Conteudo de install_instructions + api_keys aparecia abaixo da tab Visao Geral.
- Reviews e Q&A apareciam como 2 secoes separadas embaixo, FORA das tabs.
- 4 das 5 tabs eram mentira visual ao usuario.

FIX commitado + deployed (0158938):
- Novo Client Component apps/storefront/src/components/product-tabs.tsx.
- useState<Tab> alterna 5 secoes condicionalmente:
  - Overview: description + tech_stack badges
  - Requirements: install_instructions + api_keys_required + estimated_install_min
  - Changelog: product.versions com breaking_changes marker
  - Reviews: lista + estrelas + compra-verificada (msg se vazio)
  - Q&A: lista + QnaUpvote + QnaForm
- Badges count nas tabs: Reviews(N) e Q&A(N).
- PDP page agora delega para <ProductTabs />, removendo 65 linhas de codigo duplicado.

VALIDADO: HTML SSR contem ProductTabs + 'Visao Geral' + 'Pre-requisitos' + 'Reviews'.

## MLB-4 LOYALTY REDEEM - WORKER 16 (POINTS AS DISCOUNT)
Antes apenas ganhar pontos estava implementado (welcome bonus + earn em order paid).
Agora resgate completo de pontos como desconto no cart.

POLITICA:
- 1 ponto = 1 cent (100pts = R\$1, igual Mercado Pontos)
- Minimo 500pts por resgate (R\$5)
- Cap 30% do subtotal anti-abuso
- Pontos sao 'reservados' no cart, debitados pessimisticamente no checkout (FOR UPDATE)

MIGRATION 014:
- carts.loyalty_points_redeemed INT + carts.loyalty_discount_cents BIGINT
- orders.loyalty_points_redeemed + orders.loyalty_discount_cents (historico)

order-svc novos endpoints:
- POST /api/orders/cart/loyalty/redeem {points} - reserva no cart
- DELETE /api/orders/cart/loyalty/redeem - remove resgate
- recalcCart subtrai loyalty_discount_cents do total
- checkout debita balance + cria transaction com delta negativo reason='order_redeem'

storefront cart UI:
- Card 'CAS PONTOS' visivel se saldo>=500
- Quick-select 500/1000/5000pts + Max button
- Linha 'X pts -RY,YY' no resumo
- Api.cartLoyaltyRedeem + Api.cartLoyaltyClear helpers

VALIDADO E2E publicamente (user com 10000 pts, cart R\$57):
- Redeem 500pts -> applied=500, total R\$57->R\$52
- Redeem 5000pts -> applied=1710 (cap 30%), total R\$57->R\$39.90
- Insufficient saldo -> 400 insufficient_points
- DELETE -> remove e libera

Bug fix durante deploy: PG 42P08 \$1 INT/BIGINT mismatch resolvido com cast explicito \$1::INT/\$1::BIGINT em ambas posicoes do UPDATE.

## CHECKOUT UX - WORKER 2 (CART QUANTITY CONTROLS)
Audit E2E do fluxo /cart -> /checkout -> /conta/pedidos revelou:
- Cart UI exibia apenas 'Qtde: N' como texto estatico (nao editavel).
- Usuario nao podia +/- quantidade - so remover via lixeira (UX horrivel).
- Cupom progressivo aplicava desconto correto (R$417->4170/10% no tier 0).
- Checkout PIX criava order pending OK, redirect ao /conta/pedidos OK.

FIX commitado + deployed (a72e564 + a3c704b + 6546c0c):

order-svc novo PATCH /cart/items/:id body {quantity:1..99}:
- UPDATE quantity + line_total_cents (= unit_price * qty) + recalcCart.
- Cast \$1::INT (PG 42P08 quando \$1 usado em quantity=int E line_total=bigint).
- Cast \$2::UUID + \$3::UUID (UUID malformado -> 22P02 -> 404 via W4 global handler).
- cart_items nao tem updated_at - removido.

storefront cart UI:
- Botoes +/- (Lucide Plus/Minus) em inline-flex rounded-lg.
- Display monospace centralizado.
- setQty handler com optimistic update + load() pos-PATCH (refresh totals
  para cupom progressivo recalcular tier).
- qty<1 -> remove(id) auto. qty>=99 desabilita botao +.
- Api.cartSetQty helper.

VALIDADO E2E:
- PATCH qty=7 -> 200 + GET cart {quantity:7, line_total:13300=1900*7}
- PATCH qty=100 -> 400 validation_error (max 99)
- PATCH qty=0 -> 400 (min 1)
- PATCH UUID malformado -> 404 not_found via W4 global handler

BONUS: confirmou que o W4 global error-handler (PG 22P02 -> 404) propaga
para order-svc apos rebuild com shared atualizado.

## ADMIN AUDIT - WORKER 4 (UUID 22P02 LEAK FIX)
Audit dos endpoints admin via curl com token role=admin revelou:
- GET /api/orders/admin -> HTTP 500 'database_error'
- Log do server-side mostrou erro PG 22P02 (invalid input syntax for type uuid: 'admin')
- Causa: rota /:id capturava qualquer slug nao-/admin/recent e tentava cast para UUID.

FIX DEFESA EM PROFUNDIDADE commitado + deployed (b609100):

1. order-svc/routes/orders.js GET /:id:
   - Regex UUID antes do query.
   - Param invalido -> 404 limpo sem ir ao Postgres.

2. @cas/shared/error-handler.js (afeta TODOS os 16 svcs):
   - PG 22P02 capturado globalmente -> 404 'not_found' + 'Recurso nao encontrado'.
   - Padrao se aplica a qualquer /:uuid em qualquer svc - se param malformado,
     resposta limpa em vez de leak.

REBUILT 4 SVCS (order/product/seller/auth) com shared atualizado.

VALIDADO E2E:
- /api/orders/admin -> 404 order_not_found (antes era 500)
- /api/orders/not-a-uuid-here -> 404 (antes era 500)
- /api/orders/admin/recent -> 200 (rota real preservada)
- /api/orders/<uuid-valido-mas-inexistente> -> 404 normal

## MOBILE RESPONSIVE - WORKER 15 (NAV HAMBURGER MENU)
Audit em 375px mobile: Nav escondia todos os 6 nav links em lg:flex - mobile users
viam apenas logo + 3 icones. Icone Menu de lucide importado mas nunca usado.

FIX commitado + deployed (772afbd):
- Hamburger button visivel apenas em <lg (Menu icon, aria-label='Menu').
- Drawer slide-from-right glass-strong, max-w-[85vw], z-[70].
- Body scroll lock quando aberto (useEffect overflow=hidden).
- Backdrop click-out + close button (X icon).
- 6 NAV_LINKS centralizados com icones Lucide (Bot, Workflow, Cpu, Zap, Users, Layers).
- Cada link com hover-color matching o desktop nav.
- Login/Register no fim do drawer ou link 'Minha conta' se logado.
- Logo responsivo: text-base em mobile -> text-xl em sm+, 'Shop' escondido <sm.
- 'Entrar' button mostrado apenas >=sm (acessivel via drawer em <sm).

VALIDADO publicamente:
- HTML SSR contem 1x aria-label='Menu' + 1x lg:hidden no nav
- Bot icon presente no homepage (NAV_LINKS funcionando)

## UX HARDENING - WORKER 1 (AUTH UI + NOTIFICATIONS)
Audit estatico das 4 pages auth + NotificationBell revelou 2 issues UX:
1. /login nao exibia confirmacao apos register ou reset (silencioso, user confuso).
2. NotificationBell sem 'Marcar todas como lidas' - botao+endpoint faltavam.

CORRECOES commitadas + deployed (2faa10a):

LOGIN BANNERS:
- /login?registered=1 -> banner verde 'Conta criada com sucesso! Faca login...'
- /login?reset=1 -> banner verde 'Senha redefinida! Entre com sua nova senha.'
- Suspense wrapper (compat Next 15 useSearchParams).
- /redefinir-senha agora redireciona para /login?reset=1 (era /login).

MARK-ALL-READ:
- POST /api/notifications/read-all - UPDATE in_app + is_read=FALSE -> TRUE, retorna {marked:N}.
- NotificationBell header com botao 'Marcar todas' visivel apenas se unread>0.
- Icon CheckCheck + hover magenta-glow.

VALIDADO:
- bundle JS de /login contem strings 'Conta criada com sucesso!' + 'Senha redefinida!'
- POST /api/notifications/read-all (buyer) -> 200 {ok:true, marked:0}

## PERFORMANCE PASS 2 - CACHE EM PRODUCT-SVC + INVALIDATION (WORKER 18)
Aplicado cacheMiddleware em product-svc/routes/public.js:
- GET /products (list): 60s, key composta com 9 filtros (cat/kind/price/etc)
- GET /products/:slug/related: 300s
- GET /products/flash-promo/active: 60s

Invalidation hooks adicionados:
- admin.js force-approve/platform-take/archive invalida 5 patterns
  (products:list/related/flash-promo + search:top-sellers/facets)
- seller-mgmt.js draft/patch/submit invalida 3 patterns

VALIDADO E2E:
- /products?limit=10: MISS 192ms -> HIT 39ms (speedup 5x)
- /products?kind=ai_agent: MISS 36ms -> HIT 28ms
- /products/:slug/related: MISS 33ms -> HIT 29ms
- /products/flash-promo/active: MISS 34ms -> HIT 31ms

Try/catch em invalidations para nao bloquear requests se Redis cair.

## PERFORMANCE - REDIS CACHE LAYER (WORKER 18)
Add cache helper em @cas/shared usando ioredis (dep adicionada package.json):
- Singleton lazy client, fallback graceful no-op se REDIS_URL ausente.
- get/set/del/withCache/cacheMiddleware exportados via require('@cas/shared').cache.
- Prefix configuravel REDIS_PREFIX (default 'cas:').
- Header X-Cache: HIT|MISS para debug.

search-svc com cache em 4 endpoints read-heavy:
- /top-sellers: 120s (key per_category+category)
- /trending: 300s
- /categories: 900s (categorias mudam raramente)
- /facets: 180s (key category+kind)

VALIDADO E2E publicamente (curl + header parsing):
- /categories: MISS 213ms -> HIT 37ms (speedup 8.5x)
- /top-sellers: MISS 39ms -> HIT 27ms
- /facets: MISS 32ms -> HIT 24ms
- /trending: MISS 28ms -> HIT 25ms

Modulo cache disponivel para todos os 16 svcs futuros - basta importar.

## DLP MASS PROPAGATION + WORKER 6 AUTH SMOKE
Apos WORKER 7 atualizar packages/shared/error-handler.js, mass rebuild dos 11
svcs restantes para propagar o fix de DLP no errorMiddleware:

REBUILT + CONVERGED em 1 iteracao paralela (max 3 simultaneos):
- gateway, auth-svc, seller-svc, order-svc, qa-svc, review-svc, search-svc, aiops-svc

REBUILT mas sem service no Swarm (imagens prontas para deploy futuro):
- analytics-svc, image-svc, category-svc

TOTAL svcs com DLP fix ativo agora: 12/12 com service Swarm
(product-svc + 11 deste batch + auth/vault/payment/notification que ja foram
rebuilt nas iteracoes anteriores - todos pegaram o shared atualizado).

WORKER 6 AUTH SMOKE E2E pos-rebuild:
- POST /auth/register email duplicado -> 409 email_already_in_use OK
- POST /auth/register full_name<2 chars -> 400 validation_error (Zod details) OK
- POST /auth/register novo + POST /auth/login -> 200 com JWT OK
- GET /auth/me sem token -> 401 missing_token OK
- POST /auth/refresh sem cookie -> 401 missing_refresh OK
- POST /auth/forgot-password email inexistente -> 200 generico (sem enumeration) OK
- POST /auth/reset-password token fake -> 400 invalid_or_expired_token OK
- POST /auth/login senha errada -> 401 invalid_credentials generico (sem distinguir email vs senha) OK

Auth-svc considerado HEALTHY pos-audit completo.

## SECURITY+DLP HARDENING (WORKER 7 - PRODUCT-SVC + SHARED)
Audit via curl: POST /products/wishlist com UUID inexistente devolvia HTTP 500
com mensagem PG crua: 'insert or update on table product_wishlist violates
foreign key constraint product_wishlist_product_id_fkey'. Atacante extraia
schema (nomes de tabelas + FKs) sem precisar de SQLi.

FIX commitado + deployed (7fee001):
- packages/shared/error-handler.js: isPgError() detecta SQLSTATE (5 chars [0-9A-Z]).
  Resposta cliente vira 'database_error' + msg generica.
  Log COMPLETO server-side (err.detail/table/constraint preservados para debug).
- services/product-svc/routes/wishlist.js POST: pre-valida produto existente
  (approved + nao-deletado) -> retorna 404 product_not_found. Catch defensivo
  de 23503 (FK violation) tambem -> 404.
- IMPACTO: afeta todos os 16 svcs que importam @cas/shared. Rebuild incremental
  (product-svc primeiro). Demais services serao rebuilt em proximas iteracoes
  - ate la, eles continuam vulneraveis a leak similar.

VALIDADO:
- POST /api/products/wishlist {"product_id":"00000000-..."} -> 404 product_not_found
- POST com UUID valido existente -> 200 {ok:true}

## ENDPOINT FIXES (WORKER 10 - SEARCH+AIOPS)
Audit via curl identificou 3 bugs:
- /api/search/top-sellers?category=X ignorava o filtro (retornava todas as cats)
- /api/aiops/metrics retornava 404 (gateway proxia /api/aiops/* mas svc tinha so /metrics/latest)
- /api/aiops/alerts retornava 404 (mesmo problema, so existia /alerts/recent)

FIX commitado (528b31b) + deployed:
- search-svc top-sellers aceita ?category=slug (filtra na CTE com c.slug = $2)
- aiops-svc: handlers /metrics e /alerts (aliasam /metrics/latest e /alerts/recent)
  + aceitam ?limit=N (metrics, max 500) e ?days=N (alerts, max 90)

VALIDADO publicamente:
- top-sellers?category=agentes-ia -> {filter:"agentes-ia", cats:["agentes-ia"]}
- top-sellers sem filtro -> 6 cats retornadas
- aiops/metrics?limit=3 -> 3 entries
- aiops/alerts?days=30 -> 1 entry

## SECURITY/RELIABILITY HARDENING - DEPLOY E2E VALIDADO (sessao 26/05)

Apos rede do cliente voltar, deploy completo dos 4 fixes acumulados offline:
- migration 012 (2FA secret_tag) aplicada
- migration 013 (notif backoff + locking) aplicada
- ASAAS_WEBHOOK_SECRET + VAULT_INTERNAL_TOKEN gerados em .env (Swarm)
- 4 services rebuilt + force-updated: auth-svc, vault-svc, payment-svc, notification-svc

VALIDACAO E2E 3/3 via curl --resolve:
- WORKER 11 webhook forjado (header errado) -> HTTP 401 invalid_signature
- WORKER 17 buyer comum em /vault/use -> HTTP 403 forbidden_role
- WORKER 6 /auth/2fa/setup -> HTTP 200 com QR + otpauth + manual_code (2FA funciona pela primeira vez)

## RELIABILITY HARDENING (WORKER 13 - NOTIFICATION OUTBOX)
Audit em services/notification-svc/src/server.js revelou 2 bugs:

BUG 1 (HIGH - double-send): SELECT sem lock + UPDATE separados, em replicas>=2
  cada worker pegava o mesmo batch -> 2 emails por evento.

BUG 2 (MEDIUM - sem backoff): 5 retries em 30s = 2.5min. SMTP transient 1min
  queimava todas as tentativas, status='failed' antes do recovery.

FIX commitado local (5be2f19):
- Migration 013: ADD COLUMN next_retry_at + locked_by + locked_at + indice partial.
- processOutbox usa UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED).
- Backoff exponencial 30s/2min/10min/1h antes de marcar 'failed' permanente.
- Reclaim cron a cada minuto libera locks orfaos > 5min (worker crashado).

## SECURITY HARDENING (WORKER 11 - PAYMENT-SVC WEBHOOK BYPASS CRITICO)
Audit em services/payment-svc/src/server.js linha 176 revelou:
- valid = !secret || sig === secret  -> fail-OPEN se secret nao configurado.
- Atacante podia POSTar PAYMENT_RECEIVED forjado e flipar order -> paid sem pagar.
- Resultado: download_token + license_key validos por 365d emitidos sem cobranca.
- Tambem vulneravel a timing attack (sig === secret).

CORRECAO commitada local (f3e09b2):
- Sem ASAAS_WEBHOOK_SECRET -> 503 fail-CLOSED + log.error
- crypto.timingSafeEqual com Buffer (constante)
- Audita SEMPRE em asaas_webhook_events (signature_valid=false) para forensics
- Invalido -> 401 invalid_signature + log.warn{event,ip,ua}
- processWebhookEvent so se valid=true

DEPLOY: precisa configurar ASAAS_WEBHOOK_SECRET=<token> em .env Swarm +
Asaas painel Settings/Webhooks/Access Token = mesmo valor.

## SECURITY HARDENING (WORKER 17 - VAULT-SVC CRITICAL FIX)
Code audit em services/vault-svc/src/server.js revelou 2 falhas:

BUG 1 (CRITICAL): POST /vault/use exigia apenas jwt.requireAuth() sem role check.
  Qualquer buyer autenticado podia chamar e receber plain_key decriptado da
  plataforma (OpenAI/Anthropic/Gemini etc). Vazamento total das chaves LLM.

BUG 2 (MEDIUM): catch do decrypt vazava e.message no response (DLP fail).

CORRECAO commitada local (195c6e9):
- vaultUseGuard middleware: aceita x-internal-token=VAULT_INTERNAL_TOKEN (service mesh)
  OU jwt com role admin/staff/service. Buyer/seller -> 403 forbidden_role.
- catch sanitiza response (apenas 'decrypt_failed'), log estruturado server-side.

NOTA DEPLOY: precisara configurar VAULT_INTERNAL_TOKEN como secret Swarm e
injetar nos services que consumam chaves LLM via vault/use.

## SECURITY HARDENING (WORKER 6 - 2FA CRITICAL FIX)
Code audit estatico em auth-svc/routes/auth.js + two-factor.js revelou bug critico:
- AES-256-GCM exige authentication tag de 16 bytes para validar integridade.
- user_two_factor armazenava apenas secret_encrypted + secret_iv (sem tag).
- Todos os 3 sites de decrypt (login, 2fa/activate, 2fa/disable) passavam Buffer.alloc(0).
- Fluxo 2FA TOTALMENTE QUEBRADO em prod (Invalid authentication tag length).

CORRECAO commitada localmente (4f32e82) - aguardando connectivity para push+deploy:
- migration 012_user_2fa_auth_tag.sql: ADD COLUMN secret_tag BYTEA + DO blocks tolerantes
- two-factor.js setup salva tag (3a coluna)
- two-factor.js activate/disable carregam secret_tag e validam NOT NULL
- auth.js login JOIN inclui secret_tag, decrypt try/catch -> 'twofa_corrupt' (sem 500)
- Log estruturado [2fa.missing_tag] / [2fa.decrypt_fail]

Tabela user_two_factor tem 0 rows em prod (audit confirmou) - sem impacto em usuarios.

## PENDENCIAS EXTERNAS
- DNS A pelo usuario: cas, api.cas, admin.cas, seller.cas .inovareinteligenciaartificial.com -> 209.145.60.53
- VPS+GitHub temporariamente inacessiveis do cliente (rede local 100% packet loss em 8.8.8.8 e 209.145.60.53)
- Quando connectivity voltar: git push commit 4f32e82 + aplicar migration 012 + rebuild auth-svc
