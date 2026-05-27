# W7 MARCO - 100 micro-iters Pattern W7

**Período**: pass 1 → pass 100
**Endpoints com Pattern W7 aplicado**: 108
**Regras consolidadas**: 23 (A-W)
**Último commit antes do marco**: `49ae6cd` (pass 99)

## Status real vs prod

**Sandbox local**: 100% dos passes commitados + push GitHub OK
**VPS prod (`server2.inovareinteligenciaartificial.com`)**: **NÃO VALIDADO** — requer SSH manual para `git pull + docker stack deploy + curl --resolve`.

Script para deploy + validação: `deploy/w7-deploy-validate.sh`

```bash
ssh root@209.145.60.53  # senha sW5pgAG9obRu
cd /opt/cas
bash deploy/w7-deploy-validate.sh
```

## 23 regras Pattern W7 consolidadas

| Regra | Descrição                                              | Endpoints   |
|-------|--------------------------------------------------------|-------------|
| A     | status IN ('approved','platform_owned')                | 12+         |
| B     | deleted_at IS NULL                                     | 9+          |
| C     | JOIN (não subqueries)                                  | 8+          |
| D     | Tiebreakers determinísticos (id ASC/DESC)              | 50+         |
| E     | Response shape consistente (total + has_more + limit)  | 40+         |
| F     | Parent 404 distinguível (não 200 [])                   | 5+          |
| G     | SQL LIKE escape % _ \                                  | 2           |
| H     | COALESCE null arrays (json_agg → '[]'::JSON)           | 6+          |
| I     | SELECT explicit fields (sem .*)                        | 30+         |
| J     | Orphan detection (admin queue auditável)               | 3+          |
| K     | FOR UPDATE write paths (tx + lock pessimistico)        | 15+         |
| L     | Resource caps (Max products, max storage, payout cap)  | 3           |
| M     | Ownership check (Regra M)                              | 10+         |
| N     | State machine validation                               | 5+          |
| O     | Multi-phase atomicity (3-phase commit)                 | 2           |
| P     | Crypto-sensitive tables + audit_log atomic             | 15+         |
| Q     | Idempotent terminal operations                         | 10+         |
| R     | Destination whitelist                                  | 2           |
| S     | Service-token internal                                 | 3           |
| T     | Gateway BLOCK upfront                                  | 3           |
| U     | Body-size cap                                          | 2           |
| V     | Timeout per-route                                      | 4           |
| W     | RFC 6238 anti-replay TOTP                              | 1           |

## Padrões cross-svc consolidados

### LGPD role-tier masking (10 endpoints)
- review-svc: 3 (admin/reports, qna/seller/pending, seller/received)
- order-svc: 2 (admin/recent, admin/disputes)
- seller-svc: 3 (sla-risk, all, pending-kyc)
- product-svc: 1 (admin/qa-queue)
- qa-svc: 1 (runs/:product_id - seller vs admin)

### DLP cross-svc (7 svcs)
- payment-svc (webhooks/dead processing_error + reset processing_error WRITE)
- notification-svc (payload JSONB recursive)
- aiops-svc (alerts.message + alerts.payload + audit_log.payload_after)
- vault-svc (revoked_reason)
- seller-svc (rejected_reason + search_log)
- search-svc (search_log + autocomplete cache key SHA-256)
- gateway (request URL + err.message em proxy.error/timeout)
- auth-svc (user_agent audit_log)

### Regra L resource caps (3 svcs)
- seller-svc: payout amount cap
- product-svc: max_products_per_seller (default 500) + max_seller_storage_bytes (5GB)

### Regra P audit_log atomic (15+ endpoints)
vault.revoke, dispute.resolve, qna.answer, review.reply, reports.resolve,
kyc.approve/reject, seller.suspend/reactivate, payment.payouts,
webhook.reset + reset_failed, product.patch, product.submit,
product.version_publish, qna.answer (deprecated), notification.read_all,
notification.test_email_sent, user.patch_profile, auth.logout + logout_all

### Admin bypass pattern (5 endpoints)
- review-svc: /qna/:id/answer + /seller/received + /qna/seller/pending
- product-svc: /admin/qa-queue + /products/me

### Tier-split healthcheck (1 endpoint)
- aiops-svc: /status (public min) + /status/detail (admin)

### DEPRECATED routes (1)
- product-svc POST /products/me/:id/qna/:qid/answer → 410 Gone + audit forense
  (consolidate review-svc /qna/:id/answer pass 36)

## Próximos passos sugeridos

### W7 pass 101+
- review-svc remaining endpoints (POST /qna upvote, etc)
- order-svc /admin/financials endpoint (se criar)
- vault-svc /use endpoint
- notification-svc cron processor audit

### W3 pass 14
- Dialog wrapper e2e tests (Playwright)

### W14 monitoring
- Aguardar 2+ semanas prod stats em `/aiops/db/dead-indexes`
- Drop idx candidatos pos-warm-up

### Operacional (deferred deploy)
- SSH manual + deploy script + curl --resolve validation
- DNS validation
- SSL certificate verification
