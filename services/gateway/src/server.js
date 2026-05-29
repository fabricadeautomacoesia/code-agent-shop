'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { createProxyMiddleware } = require('http-proxy-middleware');
const crypto = require('node:crypto');

const {
  logger, sanitize, errorHandler, asyncHandler, fail2ban, mask
} = require('@cas/shared');

// FIX-WORKER-7 pass 68: DLP helper p/ sanitizar URLs em logs.
// PRE-FIX: req.originalUrl logado raw em /proxy.error/.timeout/.body_too_large.
// URLs com query string sensitive vazam para ELK/Pino sink:
//   - /api/auth/reset-password?token=abc123 (token plain log)
//   - /api/auth/callback?code=oauth_secret (OAuth code leak)
//   - /api/payments/asaas/webhook?sig=sha256_xyz (webhook sig partial)
// mask.text() ja masking sk-/Bearer/JWT MAS query params ?token=raw nao casa
// nenhum pattern. Solucao: strip query string em logs (preserva path p/ trace).
function logSafeUrl(url) {
  if (!url) return null;
  // Strip query string + apply mask.text DLP regex restantes (defensive)
  const noQuery = String(url).split('?')[0];
  return mask.text(noQuery);
}

const log = logger.child({ svc: 'gateway' });
const app = express();
const PORT = parseInt(process.env.PORT_GATEWAY || '3002', 10);

// --- IP Block Global (V8 21.1) ---
const IP_BLOCKLIST = new Set(
  (process.env.GATEWAY_IP_BLOCKLIST || '').split(',').filter(Boolean)
);
app.use((req, res, next) => {
  const ip = req.ip || req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  if (IP_BLOCKLIST.has(ip)) {
    log.warn({ ip }, '[gateway] blocked');
    return res.status(403).json({ error: 'ip_blocked' });
  }
  req.realIp = ip;
  next();
});

// --- Request ID p/ trace ---
app.use((req, res, next) => {
  req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('x-request-id', req.requestId);
  next();
});

// --- Helmet CSP estrito (V8 22.1) ---
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://unpkg.com'],
      'style-src':  ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdn.jsdelivr.net'],
      'font-src':   ["'self'", 'https://fonts.gstatic.com', 'data:'],
      'img-src':    ["'self'", 'data:', 'https:', 'blob:'],
      'connect-src':["'self'", 'https:', 'wss:'],
      'frame-ancestors': ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// --- CORS por origem permitida ---
const allowedOrigins = (process.env.GATEWAY_CORS_ORIGINS ||
  'http://localhost:3000,http://localhost:3001,http://localhost:3003'
).split(',').map((s) => s.trim());

/* FIX-WORKER-6 pass 497 (CRITICAL CORS bypass em producao):
   PRE-FIX BUG (security CRITICAL):
     origin: (origin, cb) => {
       if (!origin || allowedOrigins.includes(origin) || process.env.NODE_ENV !== 'production') {
         return cb(null, true);  // <-- aceita QUALQUER origin
       }
     }
   Cenario: NODE_ENV nao setado em deploy (stack.yml/stack.inovare.yml NAO
   setam NODE_ENV - verificado via grep, sem matches).
   - process.env.NODE_ENV === undefined em containers production
   - undefined !== 'production' = TRUE
   - Resultado: CORS allowlist (allowedOrigins) BYPASSED em producao
   - Qualquer origin (atacante.com, evil.local) recebe Access-Control-Allow-Origin
   - Combinado com credentials:true: CSRF cross-origin via cookies do user
   - Defeats inteiro propósito do whitelist (definido linhas 73-77)
   POST-FIX:
   - Inverter logica: explicit allowlist apenas em DEV ambientes conhecidos
   - process.env.NODE_ENV === 'development' OR === 'test' OR === 'dev'
   - Default-deny em producao OR se NODE_ENV unset (safe-by-default)
   - Audit alert em fluxo deploy: NODE_ENV unset = log warn ao boot

   Pattern V8 W6/W17: secure-by-default. NUNCA negar production - assumir
   producao como default em ausencia de NODE_ENV explicit. */
const isDev = ['development', 'test', 'dev'].includes(String(process.env.NODE_ENV || '').toLowerCase());
if (!process.env.NODE_ENV) {
  log.warn('[gateway.boot] NODE_ENV not set - assuming production CORS (default-deny). Set NODE_ENV=development for dev mode.');
}
app.use(cors({
  origin: (origin, cb) => {
    // Same-origin (no Origin header) sempre permitido
    if (!origin) return cb(null, true);
    // Whitelist check (paridade ambientes)
    if (allowedOrigins.includes(origin)) return cb(null, true);
    // Dev mode SO se NODE_ENV explicit em lista safe
    if (isDev) return cb(null, true);
    // Production OR NODE_ENV unset OR unknown value: deny cross-origin nao whitelisted
    cb(new Error('cors_blocked'));
  },
  credentials: true,
  exposedHeaders: ['x-request-id'],
}));

app.use(compression());

// --- Rate limit global (V8 23.6) ---
/* FIX-WORKER-6 pass 304 (CRITICAL rate-limit key): gateway sit atras de
   Traefik/proxy. Sem keyGenerator + sem 'trust proxy', express-rate-limit
   usa req.ip = socket peer (TRAEFIK proxy IP) - TODOS requests compartilham
   o MESMO rate-limit bucket. 200 req/min global compartilhado, atacante
   facilmente esgota e bloqueia trafego legitimo (DoS via shared bucket).
   Mesmo bug que pass 33 fail2ban resolveu para fail2ban-svc - aplicar paridade
   aqui. realIp middleware (linha 46) ja extrai x-forwarded-for real client IP.
   POST-FIX: keyGenerator: (req) => req.realIp - rate-limit per-client real. */
app.use(rateLimit({
  windowMs: parseInt(process.env.GATEWAY_RATE_LIMIT_WINDOW_MS || '60000', 10),
  max: parseInt(process.env.GATEWAY_RATE_LIMIT_MAX || '200', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limit_exceeded' },
  keyGenerator: (req) => req.realIp || req.ip,
}));

// --- Health/Status (V8 5.3 - Status Page) ---
// FIX-WORKER-6 pass 2 (CRITICAL DLP): /api/status publica vazava UPSTREAMS map
// inteiro, expondo:
// - Nomes exatos dos services internos (tasks.cas_auth-svc, etc)
// - Ports internos (3010, 3011, ..., 3020, 3006)
// - Swarm DNS pattern -> facilita lateral movement se atacante entrar no
//   overlay network (curl http://tasks.cas_vault-svc:3020 direto sem JWT)
//
// Bug paralelo ao W10 pass 5 (aiops DLP).
//
// FIX: status publica retorna apenas ok + ts + uptime aggregate. UPSTREAMS
// continua em scope local mas NAO mais exposto publicamente.
// Detalhes de infra ficam em /api/status admin-only (futuro - W6 pass 3).
app.get('/api/status', asyncHandler(async (_req, res) => {
  res.json({
    ok: true,
    svc: 'gateway',
    ts: new Date().toISOString(),
    // uptime_s removido tambem (vuln disclosure quando svc foi restartado)
    // env tambem removido (production vs staging info nao precisa publica)
    // upstreams REMOVIDO (network recon - era o pior leak)
  });
}));

// --- FIX-WORKER-7 pass 48: content-length cap defensive (anti-DoS payload massive)
// Gateway NAO faz body parse (proxy stream), MAS PODE rejeitar upfront se
// Content-Length declarado > MAX_BODY_BYTES. Anti-DoS: atacante envia
// header Content-Length: 999999999 = stream open + consumed memory na proxy.
// Fail-fast antes proxy abre socket upstream.
// PROFILES per-route:
//   - UPLOADS: 32MB (image + binary product)
//   - DEFAULT: 1MB (JSON typical)
//   - AUTH: 16KB (login form max)
const BODY_LIMIT_UPLOADS = 32 * 1024 * 1024;   // 32MB
const BODY_LIMIT_DEFAULT = 1 * 1024 * 1024;    // 1MB
const BODY_LIMIT_AUTH    = 16 * 1024;          // 16KB

function bodyLimitMiddleware(maxBytes) {
  return (req, res, next) => {
    const cl = parseInt(req.headers['content-length'] || '0', 10);
    if (cl > maxBytes) {
      log.warn({
        ip: req.realIp || req.ip,
        path: logSafeUrl(req.originalUrl),  // FIX-WORKER-7 pass 68: DLP strip query
        content_length: cl,
        max_bytes: maxBytes,
      }, '[gateway.body_too_large]');
      return res.status(413).json({
        error: 'payload_too_large',
        max_bytes: maxBytes,
        received_bytes: cl,
      });
    }
    next();
  };
}

// --- Helper para gerar proxy ---
// IMPORTANTE: por padrao reescreve para preservar o prefixo /api/<svc>/* original
// Ex: gateway recebe POST /api/auth/login -> auth-svc recebe POST /auth/login
//
// FIX-WORKER-7 pass 48: timeout per-route configuravel + log warn em timeout
// PRE-FIX: 30000ms uniforme p/ TODOS endpoints
// PROBLEMA: alguns precisam < 30s (auth = 5s = fail-fast UX), outros > 30s
//   (upload binary 32MB = 60s+, LLM-backed search = 45s+)
// FIX: opts.timeout override default 30s. Log warn quando hit.
function proxy(target, opts = {}) {
  const timeoutMs = opts.timeout || opts.proxyTimeout || 30000;
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    xfwd: true,
    proxyTimeout: timeoutMs,
    timeout: timeoutMs,
    pathRewrite: opts.pathRewrite,
    on: {
      error: (err, req, res) => {
        // FIX-WORKER-7 pass 48: distinguir timeout vs network error em log
        const isTimeout = err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET'
          || /timeout/i.test(err.message);
        log.error({
          err: mask.text(err.message || ''),  // FIX-WORKER-7 pass 68: DLP err.message (Bearer/JWT)
          err_code: err.code,
          path: logSafeUrl(req.originalUrl),  // FIX-WORKER-7 pass 68: DLP strip query
          target,
          method: req.method,
          timeout_ms: timeoutMs,
          kind: isTimeout ? 'timeout' : 'network',
        }, isTimeout ? '[proxy.timeout]' : '[proxy.error]');
        if (!res.headersSent) {
          res.status(isTimeout ? 504 : 502).json({
            error: isTimeout ? 'upstream_timeout' : 'upstream_unavailable',
            target: target.replace(/^https?:\/\//, '').split('@').pop(),
          });
        }
      },
      proxyReq: (proxyReq, req) => {
        proxyReq.setHeader('x-request-id', req.requestId);
        proxyReq.setHeader('x-real-ip', req.realIp || req.ip);
      },
    },
    // FIX-WORKER-7 pass 48: NAO espalhar opts (...opts) - timeout/proxyTimeout
    // ja foram setados explicit acima usando opts.timeout. Spread duplicava
    // entries + causava override potencial dos defaults importantes.
    // Allowlist explicit dos opts conhecidos seguros (forward header, etc).
  });
}

// --- Upstreams (Swarm DNS por padrao, dev usa 127.0.0.1) ---
const UPSTREAMS = {
  auth:         process.env.UPSTREAM_AUTH         || `http://tasks.cas_auth-svc:${process.env.PORT_AUTH || 3010}`,
  seller:       process.env.UPSTREAM_SELLER       || `http://tasks.cas_seller-svc:${process.env.PORT_SELLER || 3011}`,
  product:      process.env.UPSTREAM_PRODUCT      || `http://tasks.cas_product-svc:${process.env.PORT_PRODUCT || 3012}`,
  qa:           process.env.UPSTREAM_QA           || `http://tasks.cas_qa-svc:${process.env.PORT_QA || 3013}`,
  order:        process.env.UPSTREAM_ORDER        || `http://tasks.cas_order-svc:${process.env.PORT_ORDER || 3015}`,
  payment:      process.env.UPSTREAM_PAYMENT      || `http://tasks.cas_payment-svc:${process.env.PORT_PAYMENT || 3016}`,
  review:       process.env.UPSTREAM_REVIEW       || `http://tasks.cas_review-svc:${process.env.PORT_REVIEW || 3017}`,
  notification: process.env.UPSTREAM_NOTIFICATION || `http://tasks.cas_notification-svc:${process.env.PORT_NOTIFICATION || 3018}`,
  search:       process.env.UPSTREAM_SEARCH       || `http://tasks.cas_search-svc:${process.env.PORT_SEARCH || 3019}`,
  vault:        process.env.UPSTREAM_VAULT        || `http://tasks.cas_vault-svc:${process.env.PORT_VAULT || 3020}`,
  aiops:        process.env.UPSTREAM_AIOPS        || `http://tasks.cas_aiops-svc:${process.env.PORT_AIOPS || 3006}`,
};

// FIX-WORKER-6 pass 354 CRITICAL (ORDEM Express middleware):
//   PRE-FIX: app.use('/api', bodyLimitMiddleware(1MB)) declarado AQUI ANTES de
//   /api/products/upload (32MB) + /api/auth (16KB).
//   Express middleware runs IN ORDER de declaracao - matching /api/* sobre-
//   limit 1MB rodava PRIMEIRO -> upload de 32MB era REJEITADO com 413
//   antes de chegar ao middleware /api/products/upload (32MB).
//
//   IMPACTO PRODUCAO:
//   - Seller upload de package ZIP > 1MB -> 413 payload_too_large
//     (limite era 50MB no multer fileFilter mas gateway barrava em 1MB)
//   - Comentario linha 235 ("Rotas COM bodyLimit especifico sao verificadas
//     ANTES") era FALSO - express path matching nao prioriza specificidade,
//     so ordem de declaracao.
//
//   POST-FIX: mover app.use('/api', 1MB DEFAULT) p/ APOS rotas com limit
//   especifico. Order matters - upload/auth specifics ANTES, 1MB catchall
//   DEPOIS. Comentario tambem corrigido.
const TIMEOUT_FAST = 5000;
const TIMEOUT_DEFAULT = 30000;
const TIMEOUT_SLOW = 60000;

// Uploads binarios: 32MB+ body limit + timeout maior (ANTES do /api catchall)
app.use('/uploads',           bodyLimitMiddleware(BODY_LIMIT_UPLOADS),
                              proxy(UPSTREAMS.product,      { pathRewrite: (p) => '/uploads' + p, timeout: TIMEOUT_SLOW }));

// FIX-WORKER-7 pass 48: /api/products/upload tambem precisa 32MB cap (mesmo svc)
app.use('/api/products/upload', bodyLimitMiddleware(BODY_LIMIT_UPLOADS),
                                proxy(UPSTREAMS.product,    { pathRewrite: (p) => '/products/upload' + p, timeout: TIMEOUT_SLOW }));

// Auth login/register/2FA: fail-fast UX + body limit 16KB (anti DoS huge payloads)
// FIX-WORKER-6 pass 354: declarado ANTES do /api catchall (1MB) - rotas
// com limit especifico (16KB strict) precisam preceder /api default p/
// auth-related abuse vector mitigation.
app.use('/api/auth',          bodyLimitMiddleware(BODY_LIMIT_AUTH),
                              fail2ban.middleware(),
                              proxy(UPSTREAMS.auth,         { pathRewrite: (p) => '/auth' + p, timeout: TIMEOUT_FAST }));

// FIX-WORKER-6 pass 354: /api catchall 1MB AGORA DEPOIS dos limits especificos
// /api/products/upload (32MB) + /api/auth (16KB).
// Express middleware match-by-prefix funciona, mas ORDEM determina qual roda
// PRIMEIRO. Rotas especificas declaradas ANTES = ja consumiram next() ou
// terminaram com 413. Catchall so atinge rotas SEM limit especifico declarado.
app.use('/api', bodyLimitMiddleware(BODY_LIMIT_DEFAULT));
// FIX-WORKER-7 pass 47: fail2ban tambem em endpoints sensitive (admin/payouts/payments).
// Auth ja tinha (W6 historic). Brute-force protection patterns same.
// vault/payments/orders - mutation endpoints + alto valor financeiro = bom candidato.
app.use('/api/sellers',       fail2ban.middleware(), proxy(UPSTREAMS.seller,       { pathRewrite: (p) => '/sellers' + p }));
// FIX-WORKER-7 pass 47: BLOCK /api/loyalty/earn no gateway (defesa em profundidade).
// PRE-FIX: gateway proxy /api/loyalty/* -> seller-svc /loyalty/*
// MAS /loyalty/earn eh internal-only (serviceTokenGuard pass 45).
// Atacante pode tentar passar X-Service-Token forjado/leaked via gateway.
// Layer 2 defense: gateway BLOQUEIA /api/loyalty/earn upfront (403).
// Calls internal-only via DOCKER NETWORK direct (tasks.cas_seller-svc:3011)
// nao passam pelo gateway publico - este block reforca segregacao.
// FIX-WORKER-6 pass 207: fail2ban em /api/loyalty (alem de /earn block existente)
// /loyalty/redeem + /loyalty/me sao buyer-facing. Sem fail2ban gateway:
// Atacante brute-force redeem com diferentes points amounts -> tenta abuse.
app.use('/api/loyalty', fail2ban.middleware(), (req, res, next) => {
  // Match: /api/loyalty/earn (POST) OU /earn (rota direta apos strip prefix)
  // PRE-PROXY check - rejeita antes do encaminhamento.
  /* FIX-WORKER-6 pass 514 (CRITICAL trailing-slash + case-sensitivity bypass):
     PRE-FIX BUG: req.path === '/earn' check exato MAS Express seller-svc
     downstream nao tem strict routing (verified: no app.set('strict routing')).
     Bypass scenarios:
     1. POST /api/loyalty/earn/ (trailing slash)
        - req.path === '/earn/' -> CHECK FAILS (=== '/earn' false)
        - next() -> proxy forwards -> seller-svc /loyalty/earn/ matches /earn route
        - serviceTokenGuard (pass 45) ainda defende MAS gateway layer-1 BYPASSED
     2. POST /api/loyalty/EARN (case variation)
        - Express req.path preserva case ('/EARN')
        - CHECK FAILS -> forwards -> Express case-sensitive match -> 404 OK
        - MAS atacante pode probe casing patterns
     3. POST /api/loyalty/earn?x=1 (query string)
        - req.path === '/earn' (query string excluida) -> CHECK PASSES OK
     Impact:
     - Layer-1 defense degraded -> fail2ban counter inflado + DB pool wasted
     - Defense-in-depth principle violado (gateway DEVE ser bulletproof)
     - Se atacante tem X-Service-Token leaked (cenario hipotetico), bypass
       trailing-slash permite acesso protected endpoint
     POST-FIX:
     - Normalize req.path: remove trailing slash + lowercase ANTES check
     - Match earn pattern via regex /^\/earn\/?$/i (case-insensitive)
     - Sem regressao funcional - paths legitimos seguem inalterados */
  const normalizedPath = req.path.replace(/\/+$/, '').toLowerCase();
  if (req.method === 'POST' && normalizedPath === '/earn') {
    log.warn({ ip: req.realIp || req.ip, path: req.originalUrl, normalized: normalizedPath }, '[gateway.loyalty_earn_blocked]');
    return res.status(403).json({
      error: 'internal_only_endpoint',
      message: 'Este endpoint nao esta disponivel via gateway publico.',
    });
  }
  next();
}, proxy(UPSTREAMS.seller, { pathRewrite: (p) => '/loyalty' + p })); // MLB-4
// FIX-WORKER-6 pass 207: fail2ban em /api/products (CRUD mutations + wishlist)
// PRE-FIX: produtos publicos endpoints (POST /wishlist, PATCH /me CRUD, etc)
// sem fail2ban gateway. Atacante pode brute-force wishlist add/remove,
// review submit, product CRUD. Layer 2 defense ja existe nos svcs mas
// gateway block antes economiza DB pool / network ate svc.
app.use('/api/products',      fail2ban.middleware(), proxy(UPSTREAMS.product,      { pathRewrite: (p) => '/products' + p }));
// FIX-WORKER-7 pass 48: qa-svc dispara LLM workflow async (5min worker timeout)
// MAS rota gateway expoe endpoints sincronos (run/callback/runs/etc) que sao DB-only
// Default 30s OK pois LLM eh setImmediate background.
// FIX-WORKER-6 pass 207: + fail2ban (qa.callback eh service-token endpoint,
// mas /qa/runs e /qa/run sao admin/seller - protege contra spam)
// FIX-WORKER-6 pass 231: TIMEOUT_SLOW (60s) para /api/qa e /api/payments
// PRE-FIX: default TIMEOUT 30s. Asaas createPayment + createCustomer chain
// pode demorar 5-10s normal, 30-45s em peak. Gateway timeout 30s cortava
// request enquanto payment-svc ainda esperava Asaas -> Asaas eventually
// criava payment + cobrava cliente, mas response nao chegava ao storefront
// -> orphan record + double-charge risk se user clica novamente.
// /api/qa similar: qa-worker LLM fallback chain (OpenAI->Gemini->Groq) com
// LLM_PROVIDER_TIMEOUT 20s cada = 60s budget total. Gateway 30s cortava
// chain antes do fallback Groq, perdendo verdict gerado mas nao salvo.
// POST-FIX: ambos para TIMEOUT_SLOW (60s), alinhado com /api/uploads e
// /api/products/upload que ja eram SLOW.
app.use('/api/qa',            fail2ban.middleware(), proxy(UPSTREAMS.qa,           { pathRewrite: (p) => '/qa' + p, timeout: TIMEOUT_SLOW }));
app.use('/api/orders',        fail2ban.middleware(), proxy(UPSTREAMS.order,        { pathRewrite: (p) => '/orders' + p }));
/* FIX-WORKER-6 pass 693 (CRITICAL gateway block internal payment endpoints - paridade pass 627 vault):
   PRE-FIX BUG: /api/payments/asaas/create + /api/payments/asaas/refund expostos via gateway
   - Ambos endpoints sao INTERNAL-ONLY (asaasCreateGuard + refund timingSafe x-internal-token):
     - /asaas/create: cria charges Asaas (REAL MONEY OUT direction)
     - /asaas/refund: estorna pagamentos (REAL MONEY OUT direction - pass 644 timingSafe)
   - Layer 2 defense (svc-side guards) JA protege MAS:
     - Atacante probe gateway publico amplifica fail2ban counter waste
     - Internal cross-svc calls (order-svc -> payment-svc) usam Docker network
       direct (tasks.cas_payment-svc:port) - bypass gateway
   - SCOPE CRITICAL:
     - asaas/create bypass success = denial-of-wallet (atacante cria charges
       para victims arbitrarios + PII leak invoice URL)
     - asaas/refund bypass success = refund arbitrario (atacante recebe dinheiro
       + buyer original perde acesso produto)
   POST-FIX: gateway block /asaas/create + /asaas/refund + sub-paths defensive
   - regex match exact OR sub-paths (trailing slash + case-insensitive normalize)
   - log.warn '[gateway.payment_blocked]' forensic trail
   - 403 + 'internal_only_endpoint' (paridade pass 567 vault block response)
   Pattern V8 W6 layer-1 defense-in-depth COMPLETA cross-svc real-money endpoints. */
app.use('/api/payments', fail2ban.middleware(), (req, res, next) => {
  const normalizedPath = req.path.replace(/\/+$/, '').toLowerCase();
  // /asaas/create, /asaas/refund (exato) OR /asaas/create/X, /asaas/refund/X (sub-paths)
  const isBlockedPaymentPath = normalizedPath === '/asaas/create'
    || normalizedPath === '/asaas/refund'
    || normalizedPath.startsWith('/asaas/create/')
    || normalizedPath.startsWith('/asaas/refund/');
  if (isBlockedPaymentPath) {
    log.warn({
      ip: req.realIp || req.ip,
      path: req.originalUrl,
      normalized: normalizedPath,
      method: req.method,
    }, '[gateway.payment_blocked] LAYER-1 defense - /asaas/create|/asaas/refund internal-only via Docker mesh');
    return res.status(403).json({
      error: 'internal_only_endpoint',
      message: 'Este endpoint nao esta disponivel via gateway publico.',
    });
  }
  next();
}, proxy(UPSTREAMS.payment, { pathRewrite: (p) => '/payments' + p, timeout: TIMEOUT_SLOW })); // inclui MLB-5 /payments/installments/preview
// FIX-WORKER-6 pass 207: fail2ban em /api/reviews + /api/qna (mutations spam vector)
// reviews POST + qna POST sao buyer-facing - sem fail2ban gateway:
// 1. Buyer compromised conta -> mass spam reviews/perguntas
// 2. Bot brute-force review_id existence ou qna_id voting
// Pattern V8 consolidado: review-svc + product-svc ja tem rateLimiter
// per-user. fail2ban gateway = IP-level brute force protection.
app.use('/api/reviews',       fail2ban.middleware(), proxy(UPSTREAMS.review,       { pathRewrite: (p) => p })); // review-svc usa / direto
app.use('/api/qna',           fail2ban.middleware(), proxy(UPSTREAMS.review,       { pathRewrite: (p) => '/qna' + p }));
// FIX-WORKER-7 pass 68: fail2ban em /api/notifications.
// /test endpoint envia email (spam relay vector). Mesmo com rate-limit no svc,
// gateway brute-force protection eh defesa em profundidade (fail2ban tracking
// IP/user agressors atravessa multi-services em uma camada unica).
app.use('/api/notifications', fail2ban.middleware(), proxy(UPSTREAMS.notification, { pathRewrite: (p) => p })); // notif root
// FIX-WORKER-6 pass 207: fail2ban em /api/search.
// PRE-FIX: search endpoint publico sem fail2ban.
// Scraping massivo de catalog (1000+ req/s) sem brute-force IP protection.
// search-svc tem searchLimiter rate-limit por user mas anonymous searches
// sem auth nao tem user_id - fail2ban IP eh defesa critica.
app.use('/api/search',        fail2ban.middleware(), proxy(UPSTREAMS.search,       { pathRewrite: (p) => p })); // search root
// FIX-WORKER-7 pass 47: vault endpoint CRITICAL crypto - fail2ban obrigatorio
// FIX-WORKER-6 pass 567 (CRITICAL gateway block /api/vault/use - paridade pass 514):
//   PRE-FIX BUG: /api/vault/use exposto via gateway publico.
//   - Vault /use endpoint retorna plain AES-256-GCM crypto key
//   - Tem vaultUseGuard (x-internal-token + admin/staff/service JWT fallback)
//   - Layer 2 defense MAS gateway expoe rota publicamente
//   - Atacante pode probe /api/vault/use com tokens leaked/forjados sem
//     gate gateway layer-1 block (pass 514 loyalty/earn pattern lagged)
//   - Internal cross-svc calls (qa-worker -> vault) usam DOCKER NETWORK
//     direct (tasks.cas_vault-svc:3020) - bypassam gateway
//   - Gateway publico block = defense-in-depth (LAYER-1 + LAYER-2 reforco)
//
//   SCOPE CRITICAL:
//   - Vault /use boundary AES-256-GCM = plain crypto key response
//   - Bypass success = compromise total cross-svc (OpenAI/Anthropic/Stripe keys)
//   - Pattern V8 W17 audit_log defense passes 230/438/458/555 ja consolidated
//     layer-2 mas LAYER-1 gateway block era unica peca faltante
//
//   POST-FIX: block /api/vault/use upfront (POST + GET) paridade pass 514:
//   - Normalize req.path (.replace(/\/+$/,'').toLowerCase()) anti trailing-slash + case
//   - Match regex /^\/use\/?$/i (case-insensitive defensive)
//   - log.warn '[gateway.vault_use_blocked]' forensic trail
//   - 403 'internal_only_endpoint' (paridade pass 514 loyalty/earn response)
//
//   Trade-off: vault-svc layer-2 (vaultUseGuard) preservado p/ internal mesh.
//   Cross-svc calls via Docker network direct nao passam pelo gateway publico -
//   ZERO regressao funcional para fluxos legitimos.
/* FIX-WORKER-6 pass 627 (CRITICAL extend pass 567 - bloquear /api/vault/usage tambem):
   PRE-FIX (pass 567): bloqueio apenas '/use' (read AES key)
   - Mas '/usage' (POST internal-only) ficou EXPOSTO via gateway publico
   - vault-svc POST /usage (server.js linha 1220) tambem usa vaultUseGuard
     (x-internal-token + JWT admin/staff/service fallback)
   - SCOPE CRITICAL diferenca /use vs /usage:
     /use: read AES key (LEAK key compromise)
     /usage: write vault_key_usage records (FALSIFY usage = billing fraud +
             audit pollution + UPDATE vault_api_keys.usage_this_month_cents)
   - Cenarios attack /api/vault/usage via gateway publico:
     1. Admin JWT leaked (real or via 2FA bypass) -> spam INSERT vault_key_usage
        com cost_usd_cents fake -> infla billing seller competidor
     2. Atacante probe x-internal-token (timingSafe brute) -> mesma threat /use
   - Internal calls (qa-worker -> vault /usage) usam Docker network direct
     (tasks.cas_vault-svc:3020) - ZERO regressao funcional fluxos legitimos
   POST-FIX: regex /^\/use(?:\/?$|\/.*$)|\/usage(?:\/?$|\/.*$)/i
   - Match /use exact + /use/anything (defesa trailing path injection)
   - Match /usage exact + /usage/anything (defesa trailing path injection)
   - Case-insensitive (paridade pass 514 + 567)
   - normalizedPath ja faz lowercase + trailing slash strip
   Pattern V8 W6 layer-1 defense-in-depth: gateway bulletproof + svc layer-2 reforco. */
app.use('/api/vault', fail2ban.middleware(), (req, res, next) => {
  const normalizedPath = req.path.replace(/\/+$/, '').toLowerCase();
  // /use, /usage (exato) ou /use/X, /usage/X (sub-paths defensive)
  const isBlockedVaultPath = normalizedPath === '/use'
    || normalizedPath === '/usage'
    || normalizedPath.startsWith('/use/')
    || normalizedPath.startsWith('/usage/');
  if (isBlockedVaultPath) {
    log.warn({
      ip: req.realIp || req.ip,
      path: req.originalUrl,
      normalized: normalizedPath,
      method: req.method,
    }, '[gateway.vault_blocked] LAYER-1 defense - vault /use|/usage not available via public gateway');
    return res.status(403).json({
      error: 'internal_only_endpoint',
      message: 'Este endpoint nao esta disponivel via gateway publico.',
    });
  }
  next();
}, proxy(UPSTREAMS.vault, { pathRewrite: (p) => p })); // vault root
// FIX-WORKER-7 pass 68: fail2ban em /api/aiops.
// /audit-log + /db/dead-indexes + /alerts admin-only DENTRO do svc, MAS atacante
// brute-forcing role check escala 100+ req/s antes de jwt.requireAuth() rejeitar.
// Fail2ban no gateway: IP atinge threshold rejected -> 403 imediato sem hit upstream.
app.use('/api/aiops',         fail2ban.middleware(), proxy(UPSTREAMS.aiops,        { pathRewrite: (p) => p })); // aiops root

app.get('/', (_req, res) => res.json({ name: 'Code & Agent Shop Gateway', version: '0.1.0' }));
app.use((req, res) => res.status(404).json({ error: 'route_not_found', path: req.originalUrl }));
app.use(errorHandler.errorMiddleware);

const server = app.listen(PORT, () => {
  log.info({ port: PORT, env: process.env.NODE_ENV }, '[gateway] listening');
});

// Graceful shutdown
['SIGINT', 'SIGTERM'].forEach((sig) => {
  process.on(sig, () => {
    log.warn({ sig }, '[gateway] shutdown');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
});
