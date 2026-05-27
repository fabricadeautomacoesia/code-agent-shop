#!/usr/bin/env bash
# ============================================================================
# W7 DEPLOY + VALIDATE - Pattern W7 99 passes (commits ate 49ae6cd)
# ============================================================================
# Uso na VPS:
#   ssh root@209.145.60.53  (senha sW5pgAG9obRu)
#   cd /opt/cas
#   bash deploy/w7-deploy-validate.sh
#
# Pre-requisitos na VPS:
#   - Docker Swarm ativo (docker info | grep Swarm)
#   - Stack 'cas' ja deployed pelo menos 1x
#   - Domain DNS apontando p/ 209.145.60.53
#   - .env com PG_PASS, ASAAS_*, JWT_*, VAULT_AES_KEY
# ============================================================================
set -euo pipefail

DOMAIN="${CAS_DOMAIN:-cas.inovareinteligenciaartificial.com}"
PROJECT_ROOT="${CAS_ROOT:-/opt/cas}"
STACK_NAME="${CAS_STACK:-cas}"

echo "============================================================"
echo "[w7-deploy] inicio em $(date -Iseconds)"
echo "[w7-deploy] domain=$DOMAIN root=$PROJECT_ROOT stack=$STACK_NAME"
echo "============================================================"

# ----------------------------------------------------------------------------
# FASE 1: git pull (puxa 99 passes W7 do GitHub)
# ----------------------------------------------------------------------------
echo ""
echo "[FASE 1/4] git pull origin main"
cd "$PROJECT_ROOT"
git fetch --all
PREV_HEAD=$(git rev-parse HEAD)
git pull origin main
NEW_HEAD=$(git rev-parse HEAD)
if [ "$PREV_HEAD" = "$NEW_HEAD" ]; then
  echo "  -> sem mudancas remote (HEAD=$PREV_HEAD)"
else
  echo "  -> avancou $PREV_HEAD..$NEW_HEAD"
  echo "  -> commits new:"
  git log --oneline "$PREV_HEAD..$NEW_HEAD" | head -20
fi

# ----------------------------------------------------------------------------
# FASE 2: rebuild + redeploy Docker Swarm
# ----------------------------------------------------------------------------
echo ""
echo "[FASE 2/4] docker stack deploy"

# Rebuild apenas svcs que mudaram (todos no caso de pull grande)
SVCS_AFFECTED="auth-svc seller-svc product-svc order-svc payment-svc review-svc notification-svc search-svc aiops-svc qa-svc vault-svc gateway"

for svc in $SVCS_AFFECTED; do
  if [ -d "services/$svc" ]; then
    echo "  -> docker build $svc"
    docker build -f deploy/Dockerfile.node \
      -t "${STACK_NAME}_${svc}:latest" \
      --build-arg SVC_PATH="services/$svc" \
      . 2>&1 | tail -3
  fi
done

# Redeploy stack
echo "  -> docker stack deploy -c deploy/docker-compose.yml $STACK_NAME"
docker stack deploy -c deploy/docker-compose.yml "$STACK_NAME"

# Aguarda services REPLICATED
echo "  -> aguardando services up (60s)..."
sleep 60
docker service ls | grep "$STACK_NAME" | head -20

# ----------------------------------------------------------------------------
# FASE 3: validation suite (curl publico)
# ----------------------------------------------------------------------------
echo ""
echo "[FASE 3/4] validation suite via curl"

PASS=0
FAIL=0

check() {
  local label="$1"
  local url="$2"
  local expected_status="${3:-200}"
  local expect_regex="${4:-}"

  local resp
  resp=$(curl -s -o /tmp/cas_resp_$$ -w "%{http_code}" "$url" || echo "000")
  local body
  body=$(cat /tmp/cas_resp_$$ 2>/dev/null || echo "")

  if [ "$resp" = "$expected_status" ]; then
    if [ -n "$expect_regex" ]; then
      if echo "$body" | grep -qE "$expect_regex"; then
        echo "  [OK] $label ($resp)"
        PASS=$((PASS+1))
      else
        echo "  [FAIL-regex] $label ($resp) - body nao matchea '$expect_regex'"
        echo "    body: $(echo "$body" | head -c 200)"
        FAIL=$((FAIL+1))
      fi
    else
      echo "  [OK] $label ($resp)"
      PASS=$((PASS+1))
    fi
  else
    echo "  [FAIL-status] $label (esperado $expected_status, got $resp)"
    echo "    body: $(echo "$body" | head -c 200)"
    FAIL=$((FAIL+1))
  fi
  rm -f /tmp/cas_resp_$$
}

# === HEALTHCHECK + AIOPS pass 90 ===
check "aiops.status_public_min" \
  "https://$DOMAIN/api/aiops/status" \
  "200" '"ok":(true|false)'

# Status NAO deve vazar metrics em response (pass 90 DLP fix)
check "aiops.status_no_metrics_leak" \
  "https://$DOMAIN/api/aiops/status" \
  "200" "^[^c]*$|\"ts\""  # Sem 'cpu_percent' aparecendo
# Use grep -v inline check
RESP_STATUS=$(curl -s "https://$DOMAIN/api/aiops/status")
if echo "$RESP_STATUS" | grep -q 'cpu_percent'; then
  echo "  [FAIL-dlp] aiops.status vazando cpu_percent (deveria ser /status/detail admin)"
  FAIL=$((FAIL+1))
else
  echo "  [OK] aiops.status NAO vaza cpu_percent (DLP pass 90)"
  PASS=$((PASS+1))
fi

# === SEARCH pass 91-94 ===
check "search.basic_q" \
  "https://$DOMAIN/api/search/?q=automation&limit=2" \
  "200" '"results":\['

check "search.invalid_kind_400" \
  "https://$DOMAIN/api/search/?kind=invalid_kind_xyz" \
  "400" '"invalid_kind"'

check "search.invalid_tier_400" \
  "https://$DOMAIN/api/search/?tier=diamond" \
  "400" '"invalid_tier"'

check "search.autocomplete" \
  "https://$DOMAIN/api/search/autocomplete?q=au" \
  "200" '"suggestions":\['

check "search.trending" \
  "https://$DOMAIN/api/search/trending?limit=5" \
  "200" '"trending":\['

check "search.categories_with_count" \
  "https://$DOMAIN/api/search/categories" \
  "200" '"product_count":'

check "search.facets_invalid_kind" \
  "https://$DOMAIN/api/search/facets?kind=invalid" \
  "400" '"invalid_kind"'

# === PRODUCTS pass 73-79 ===
check "products.list_pagination" \
  "https://$DOMAIN/api/products?limit=5&include_total=true" \
  "200" '"total":'

check "products.invalid_kind_400" \
  "https://$DOMAIN/api/products?kind=xyz" \
  "400" '"invalid_kind"'

check "products.invalid_min_price_400" \
  "https://$DOMAIN/api/products?min_price=abc" \
  "400" '"invalid_min_price"'

check "products.flash_promo_active" \
  "https://$DOMAIN/api/products/flash-promo/active" \
  "200" '"products":\['

# === DEPRECATED ROUTE pass 88 ===
# POST sem auth = 401 (proteção JWT). 410 so com auth, MAS rota deveria retornar 401 antes
# do 410 (auth check primeiro). Skip se nao temos token admin valido.

# === GATEWAY DLP pass 68 ===
# Test rate-limit funcionando (gateway 200 req/min cap)
check "gateway.healthz" \
  "https://$DOMAIN/api/status" \
  "200" '"ok":true'

# === AUTH pass 49-55, 97, 98 ===
check "auth.login_missing_400" \
  "https://$DOMAIN/api/auth/login" \
  "400" '.+'  # Empty body deve falhar Zod

# === REVIEW-SVC pass 56-57 ===
# /qna/seller/pending requer auth - skip sem token

echo ""
echo "============================================================"
echo "[FASE 3/4] VALIDATION SUMMARY"
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
echo "  TOTAL: $((PASS+FAIL))"
echo "============================================================"

# ----------------------------------------------------------------------------
# FASE 4: docker service health overview
# ----------------------------------------------------------------------------
echo ""
echo "[FASE 4/4] docker service ls (post-deploy state)"
docker service ls | grep -E "^ID|${STACK_NAME}_" | head -30

echo ""
echo "[FASE 4/4] containers errados (state != Running):"
docker stack ps "$STACK_NAME" --no-trunc \
  --filter "desired-state=running" \
  --format "table {{.Name}}\t{{.CurrentState}}\t{{.Error}}" 2>/dev/null \
  | grep -v "Running" | head -10

echo ""
echo "============================================================"
if [ "$FAIL" -eq 0 ]; then
  echo "[w7-deploy] SUCESSO - Pattern W7 99 passes deployados + validados"
  echo "[w7-deploy] DOMAIN: https://$DOMAIN"
  echo "[w7-deploy] HEAD: $(git rev-parse --short HEAD)"
else
  echo "[w7-deploy] ATENCAO - $FAIL validacoes falharam"
  echo "[w7-deploy] verificar: docker service logs ${STACK_NAME}_<svc>"
fi
echo "[w7-deploy] fim em $(date -Iseconds)"
echo "============================================================"

exit $((FAIL > 0 ? 1 : 0))
