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
app.get('/api/status', asyncHandler(async (_req, res) => {
  res.json({
    ok: true,
    svc: 'gateway',
    uptime_s: process.uptime(),
    ts: new Date().toISOString(),
    env: process.env.NODE_ENV,
    upstreams: {
      auth:         `http://127.0.0.1:${process.env.PORT_AUTH || 3010}`,
      seller:       `http://127.0.0.1:${process.env.PORT_SELLER || 3011}`,
      product:      `http://127.0.0.1:${process.env.PORT_PRODUCT || 3012}`,
      qa:           `http://127.0.0.1:${process.env.PORT_QA || 3013}`,
      order:        `http://127.0.0.1:${process.env.PORT_ORDER || 3015}`,
      payment:      `http://127.0.0.1:${process.env.PORT_PAYMENT || 3016}`,
      review:       `http://127.0.0.1:${process.env.PORT_REVIEW || 3017}`,
      notification: `http://127.0.0.1:${process.env.PORT_NOTIFICATION || 3018}`,
      search:       `http://127.0.0.1:${process.env.PORT_SEARCH || 3019}`,
      vault:        `http://127.0.0.1:${process.env.PORT_VAULT || 3020}`,
      aiops:        `http://127.0.0.1:${process.env.PORT_AIOPS || 3006}`,
    },
  });
}));

// --- Helper para gerar proxy ---
function proxy(target, opts = {}) {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    xfwd: true,
    proxyTimeout: 30000,
    timeout: 30000,
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

// --- Rotas (V8 23.6) ---
// auth com fail2ban antes do proxy
app.use('/api/auth', fail2ban.middleware(),
  proxy(`http://127.0.0.1:${process.env.PORT_AUTH || 3010}`)
);
app.use('/api/sellers',       proxy(`http://127.0.0.1:${process.env.PORT_SELLER || 3011}`));
app.use('/api/products',      proxy(`http://127.0.0.1:${process.env.PORT_PRODUCT || 3012}`));
app.use('/api/qa',            proxy(`http://127.0.0.1:${process.env.PORT_QA || 3013}`));
app.use('/api/orders',        proxy(`http://127.0.0.1:${process.env.PORT_ORDER || 3015}`));
app.use('/api/payments',      proxy(`http://127.0.0.1:${process.env.PORT_PAYMENT || 3016}`));
app.use('/api/reviews',       proxy(`http://127.0.0.1:${process.env.PORT_REVIEW || 3017}`));
app.use('/api/qna',           proxy(`http://127.0.0.1:${process.env.PORT_REVIEW || 3017}`));
app.use('/api/notifications', proxy(`http://127.0.0.1:${process.env.PORT_NOTIFICATION || 3018}`));
app.use('/api/search',        proxy(`http://127.0.0.1:${process.env.PORT_SEARCH || 3019}`));
app.use('/api/vault',         proxy(`http://127.0.0.1:${process.env.PORT_VAULT || 3020}`));
app.use('/api/aiops',         proxy(`http://127.0.0.1:${process.env.PORT_AIOPS || 3006}`));

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
