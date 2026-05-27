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

// --- Helper para gerar proxy ---
// IMPORTANTE: por padrao reescreve para preservar o prefixo /api/<svc>/* original
// Ex: gateway recebe POST /api/auth/login -> auth-svc recebe POST /auth/login
function proxy(target, opts = {}) {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    xfwd: true,
    proxyTimeout: 30000,
    timeout: 30000,
    pathRewrite: opts.pathRewrite,
    on: {
      error: (err, req, res) => {
        log.error({ err: err.message, path: req.originalUrl, target }, '[proxy.error]');
        if (!res.headersSent) {
          res.status(502).json({ error: 'upstream_unavailable', target: target.replace(/^https?:\/\//, '').split('@').pop() });
        }
      },
      proxyReq: (proxyReq, req) => {
        proxyReq.setHeader('x-request-id', req.requestId);
        proxyReq.setHeader('x-real-ip', req.realIp || req.ip);
      },
    },
    ...opts,
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

// Express strip do app.use(prefix) faz proxy receber apenas o resto.
// Ex: GET /api/auth/login -> proxy.req.url = /login
// Prepend o prefixo correto que cada svc espera no proprio router:
// /uploads/* -> product-svc (sem prefix, serve static)
app.use('/uploads',           proxy(UPSTREAMS.product,      { pathRewrite: (p) => '/uploads' + p }));

app.use('/api/auth',          fail2ban.middleware(), proxy(UPSTREAMS.auth,         { pathRewrite: (p) => '/auth' + p }));
app.use('/api/sellers',       proxy(UPSTREAMS.seller,       { pathRewrite: (p) => '/sellers' + p }));
app.use('/api/loyalty',       proxy(UPSTREAMS.seller,       { pathRewrite: (p) => '/loyalty' + p })); // MLB-4
app.use('/api/products',      proxy(UPSTREAMS.product,      { pathRewrite: (p) => '/products' + p }));
app.use('/api/qa',            proxy(UPSTREAMS.qa,           { pathRewrite: (p) => '/qa' + p }));
app.use('/api/orders',        proxy(UPSTREAMS.order,        { pathRewrite: (p) => '/orders' + p }));
app.use('/api/payments',      proxy(UPSTREAMS.payment,      { pathRewrite: (p) => '/payments' + p })); // inclui MLB-5 /payments/installments/preview
app.use('/api/reviews',       proxy(UPSTREAMS.review,       { pathRewrite: (p) => p })); // review-svc usa / direto
app.use('/api/qna',           proxy(UPSTREAMS.review,       { pathRewrite: (p) => '/qna' + p }));
app.use('/api/notifications', proxy(UPSTREAMS.notification, { pathRewrite: (p) => p })); // notif root
app.use('/api/search',        proxy(UPSTREAMS.search,       { pathRewrite: (p) => p })); // search root
app.use('/api/vault',         proxy(UPSTREAMS.vault,        { pathRewrite: (p) => p })); // vault root
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
