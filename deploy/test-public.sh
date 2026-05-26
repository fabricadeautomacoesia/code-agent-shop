#!/usr/bin/env bash
# test-public.sh - testa acesso aos servicos via Traefik usando Host header manual
# Use enquanto o DNS nao propaga.

set +e
VPS=209.145.60.53

declare -A HOSTS=(
  [storefront]="cas.inovareinteligenciaartificial.com"
  [admin]="admin.cas.inovareinteligenciaartificial.com"
  [seller]="seller.cas.inovareinteligenciaartificial.com"
  [api]="api.cas.inovareinteligenciaartificial.com"
)

echo "=== Testando acesso publico via Host header (sem DNS) ==="
for svc in "${!HOSTS[@]}"; do
  host=${HOSTS[$svc]}
  echo
  echo "--- $svc -> $host ---"
  curl -sk -o /dev/null -w "HTTP %{http_code} | time %{time_total}s\n" \
    --resolve $host:443:$VPS \
    --resolve $host:80:$VPS \
    -H "Host: $host" \
    "https://$host/"
done

echo
echo "=== Test login admin ==="
curl -sk --resolve api.cas.inovareinteligenciaartificial.com:443:$VPS \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"email":"fabricadeautomacoes0@gmail.com","password":"ChangeMe!2026Inovare"}' \
  https://api.cas.inovareinteligenciaartificial.com/api/auth/login \
  | head -c 200
echo
