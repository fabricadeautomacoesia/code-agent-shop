#!/usr/bin/env bash
# smoke-remote.sh - smoke tests dentro da rede minha_rede via container temporario
# Uso (na VPS): bash deploy/smoke-remote.sh

set +e
NET=minha_rede

declare -A ENDPOINTS=(
  [gateway]="tasks.cas_gateway:3002/api/status"
  [auth]="tasks.cas_auth-svc:3010/health"
  [vault]="tasks.cas_vault-svc:3020/health"
  [seller]="tasks.cas_seller-svc:3011/health"
  [product]="tasks.cas_product-svc:3012/health"
  [qa]="tasks.cas_qa-svc:3013/health"
  [qa-worker]="tasks.cas_qa-worker:3014/health"
  [order]="tasks.cas_order-svc:3015/health"
  [payment]="tasks.cas_payment-svc:3016/health"
  [review]="tasks.cas_review-svc:3017/health"
  [notification]="tasks.cas_notification-svc:3018/health"
  [search]="tasks.cas_search-svc:3019/health"
  [aiops]="tasks.cas_aiops-svc:3006/health"
  [storefront]="tasks.cas_storefront:3000/"
  [admin]="tasks.cas_dashboard-admin:3001/"
  [seller-ui]="tasks.cas_dashboard-seller:3003/"
)

echo "=== CAS Smoke Tests ==="
OK=0; FAIL=0
for name in "${!ENDPOINTS[@]}"; do
  url="http://${ENDPOINTS[$name]}"
  result=$(docker run --rm --network $NET alpine sh -c "wget -qO- --timeout=5 $url 2>&1 | head -c 200" 2>&1)
  if [ -n "$result" ] && ! echo "$result" | grep -qiE "error|refused|timeout"; then
    printf "  OK   %-15s -> %s\n" "$name" "$(echo $result | head -c 80)"
    OK=$((OK+1))
  else
    printf "  FAIL %-15s -> %s\n" "$name" "$(echo $result | head -c 80)"
    FAIL=$((FAIL+1))
  fi
done
echo ""
echo "=== Stack services ==="
docker stack services cas | head -20
echo ""
echo "=== RESULTADO: $OK OK / $FAIL FAIL (total ${#ENDPOINTS[@]}) ==="
exit $FAIL
