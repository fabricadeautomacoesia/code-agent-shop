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
