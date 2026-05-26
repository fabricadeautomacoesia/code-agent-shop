# Configuracao de DNS - Code & Agent Shop

## Subdominios necessarios

Configure 4 registros DNS tipo **A** no seu provedor (Cloudflare/Registro.br/etc):

| Tipo | Nome | Valor (IP) | TTL |
|------|------|-----------|-----|
| A    | `cas.inovareinteligenciaartificial.com`        | `209.145.60.53` | 300 |
| A    | `api.cas.inovareinteligenciaartificial.com`    | `209.145.60.53` | 300 |
| A    | `admin.cas.inovareinteligenciaartificial.com`  | `209.145.60.53` | 300 |
| A    | `seller.cas.inovareinteligenciaartificial.com` | `209.145.60.53` | 300 |

## Verificacao

Depois de adicionar, verificar propagacao (1-15min):

```bash
# Linux/Mac/WSL/Git Bash
dig +short cas.inovareinteligenciaartificial.com
nslookup cas.inovareinteligenciaartificial.com

# Online
https://dnschecker.org/#A/cas.inovareinteligenciaartificial.com
```

Resultado esperado: `209.145.60.53` em todos.

## SSL automatico

Apos DNS propagar, Traefik gera certs Let's Encrypt automaticamente no primeiro
acesso valido HTTPS. Confirmar:

```bash
curl -vI https://cas.inovareinteligenciaartificial.com
# Procurar: SSL_connect OK + issuer="Let's Encrypt"
```

## Cloudflare Tip

Se usar Cloudflare como DNS, **desabilitar proxy** (nuvem laranja → cinza)
durante a primeira emissao do cert, depois pode ativar de novo.

## URLs finais

| URL | Servico |
|-----|---------|
| https://cas.inovareinteligenciaartificial.com        | Storefront publica (compradores) |
| https://api.cas.inovareinteligenciaartificial.com    | API Gateway (consumida pelos fronts) |
| https://admin.cas.inovareinteligenciaartificial.com  | Painel admin master |
| https://seller.cas.inovareinteligenciaartificial.com | Painel do vendedor |

## Login inicial

- Admin: `fabricadeautomacoes0@gmail.com` / `ChangeMe!2026Inovare`
- TROCAR senha no primeiro acesso!

## Acesso antes do DNS (Host header manual)

Voce pode testar antes de configurar DNS via curl com `--resolve`:

```bash
curl --resolve cas.inovareinteligenciaartificial.com:443:209.145.60.53 \
  https://cas.inovareinteligenciaartificial.com -k
```
