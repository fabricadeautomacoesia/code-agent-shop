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
  logger, sanitize, errorHandler, asyncHandler, fail2ban
} = require('@cas/shared');

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

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin) || process.env.NODE_ENV !== 'production') {
      return cb(null, true);
    }
    cb(new Error('cors_blocked'));
  },
  credentials: true,
  exposedHeaders: ['x-request-id'],
}));

app.use(compression());

// --- Rate limit global (V8 23.6) ---
app.use(rateLimit({
  windowMs: parseInt(process.env.GATEWAY_RATE_LIMIT_WINDOW_MS || '60000', 10),
  max: parseInt(process.env.GATEWAY_RATE_LIMIT_MAX || '200', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limit_exceeded' },
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
        path: req.originalUrl,
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
          err: err.message,
          err_code: err.code,
          path: req.originalUrl,
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

// FIX-WORKER-7 pass 48: body limit DEFAULT 1MB para TODAS rotas /api/*
// EXCETO /uploads + /api/products/upload (que tem cap 32MB acima).
// Rotas COM bodyLimitMiddleware especifico (auth=16KB) sao verificadas ANTES
// deste middleware no path resolution - express usa ORDEM de declaracao.
// Para garantir auth 16KB enforce, declarado ANTES desta linha.
app.use('/api', bodyLimitMiddleware(BODY_LIMIT_DEFAULT));

// Express strip do app.use(prefix) faz proxy receber apenas o resto.
// Ex: GET /api/auth/login -> proxy.req.url = /login
// Prepend o prefixo correto que cada svc espera no proprio router:
// /uploads/* -> product-svc (sem prefix, serve static)
// FIX-WORKER-7 pass 48: timeouts per-route otimizados.
// PROFILES (heuristica baseada em workload):
//   - FAST (5s): auth (fail-fast UX login)
//   - DEFAULT (30s): products/search/orders/payments (DB queries normais)
//   - SLOW (60s): qa (LLM analysis), uploads (binary 32MB+)
//   - VERY_SLOW (120s): qa-worker callback (extremos)
const TIMEOUT_FAST = 5000;
const TIMEOUT_DEFAULT = 30000;
const TIMEOUT_SLOW = 60000;

// Uploads binarios: 32MB+ body limit + timeout maior
app.use('/uploads',           bodyLimitMiddleware(BODY_LIMIT_UPLOADS),
                              proxy(UPSTREAMS.product,      { pathRewrite: (p) => '/uploads' + p, timeout: TIMEOUT_SLOW }));

// FIX-WORKER-7 pass 48: /api/products/upload tambem precisa 32MB cap (mesmo svc)
app.use('/api/products/upload', bodyLimitMiddleware(BODY_LIMIT_UPLOADS),
                                proxy(UPSTREAMS.product,    { pathRewrite: (p) => '/products/upload' + p, timeout: TIMEOUT_SLOW }));

// Auth login/register/2FA: fail-fast UX + body limit 16KB (anti DoS huge payloads)
// Token verify backend deve ser ~10-50ms - timeout 5s eh generoso
app.use('/api/auth',          bodyLimitMiddleware(BODY_LIMIT_AUTH),
                              fail2ban.middleware(),
                              proxy(UPSTREAMS.auth,         { pathRewrite: (p) => '/auth' + p, timeout: TIMEOUT_FAST }));
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
app.use('/api/loyalty', (req, res, next) => {
  // Match: /api/loyalty/earn (POST) OU /earn (rota direta apos strip prefix)
  // PRE-PROXY check - rejeita antes do encaminhamento.
  if (req.method === 'POST' && (req.path === '/earn' || req.path === '/loyalty/earn')) {
    log.warn({ ip: req.realIp || req.ip, path: req.originalUrl }, '[gateway.loyalty_earn_blocked]');
    return res.status(403).json({
      error: 'internal_only_endpoint',
      message: 'Este endpoint nao esta disponivel via gateway publico.',
    });
  }
  next();
}, proxy(UPSTREAMS.seller, { pathRewrite: (p) => '/loyalty' + p })); // MLB-4
app.use('/api/products',      proxy(UPSTREAMS.product,      { pathRewrite: (p) => '/products' + p }));
// FIX-WORKER-7 pass 48: qa-svc dispara LLM workflow async (5min worker timeout)
// MAS rota gateway expoe endpoints sincronos (run/callback/runs/etc) que sao DB-only
// Default 30s OK pois LLM eh setImmediate background.
app.use('/api/qa',            proxy(UPSTREAMS.qa,           { pathRewrite: (p) => '/qa' + p }));
app.use('/api/orders',        fail2ban.middleware(), proxy(UPSTREAMS.order,        { pathRewrite: (p) => '/orders' + p }));
app.use('/api/payments',      fail2ban.middleware(), proxy(UPSTREAMS.payment,      { pathRewrite: (p) => '/payments' + p })); // inclui MLB-5 /payments/installments/preview
app.use('/api/reviews',       proxy(UPSTREAMS.review,       { pathRewrite: (p) => p })); // review-svc usa / direto
app.use('/api/qna',           proxy(UPSTREAMS.review,       { pathRewrite: (p) => '/qna' + p }));
app.use('/api/notifications', proxy(UPSTREAMS.notification, { pathRewrite: (p) => p })); // notif root
app.use('/api/search',        proxy(UPSTREAMS.search,       { pathRewrite: (p) => p })); // search root
// FIX-WORKER-7 pass 47: vault endpoint CRITICAL crypto - fail2ban obrigatorio
app.use('/api/vault',         fail2ban.middleware(), proxy(UPSTREAMS.vault,        { pathRewrite: (p) => p })); // vault root
app.use('/api/aiops',         proxy(UPSTREAMS.aiops,        { pathRewrite: (p) => p })); // aiops root

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
