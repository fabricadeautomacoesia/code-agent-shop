#!/bin/bash
set -e
TOKEN=$(echo eyJlbWFpbCI6InRlc3RlMUBjYXMuaW8iLCJwYXNzd29yZCI6IlRlc3RlMTIzIn0= | base64 -d | curl -sk --resolve api.cas.inovareinteligenciaartificial.com:443:209.145.60.53 -X POST -H 'Content-Type: application/json' --data-binary @- https://api.cas.inovareinteligenciaartificial.com/api/auth/login | jq -r .access_token)
echo "TOKEN_LEN=${#TOKEN}"
echo "=== /api/loyalty/me ==="
curl -sk --resolve api.cas.inovareinteligenciaartificial.com:443:209.145.60.53 -H "Authorization: Bearer $TOKEN" https://api.cas.inovareinteligenciaartificial.com/api/loyalty/me
echo ""
echo "=== /conta/pontos via storefront ==="
curl -sk --resolve cas.inovareinteligenciaartificial.com:443:209.145.60.53 https://cas.inovareinteligenciaartificial.com/conta/pontos -o /tmp/pontos.html -w "HTTP:%{http_code}\n"
grep -oE '(CAS Pontos|Carregando|Tier atual|pontos_balance)' /tmp/pontos.html | head -5
