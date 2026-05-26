// PM2 ecosystem para deploy nao-Docker (V8 §23.10).
// Uso: pm2 start deploy/ecosystem.config.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const ROOT = require('path').join(__dirname, '..');

const node = (name, port, cwd) => ({
  name:                `cas-${name}`,
  script:              'src/server.js',
  cwd:                 `${ROOT}/services/${cwd || name}`,
  env:                 { ...process.env, [`PORT_${name.replace(/-/g,'_').toUpperCase()}`]: port },
  instances:           1,
  exec_mode:           'fork',
  watch:               false,
  max_memory_restart:  '768M',
  autorestart:         true,
  restart_delay:       3000,
  max_restarts:        10,
  log_date_format:     'YYYY-MM-DD HH:mm:ss',
  out_file:            `${ROOT}/logs/${name}.out.log`,
  error_file:          `${ROOT}/logs/${name}.err.log`,
  merge_logs:          true,
});

const next = (name, port, dir) => ({
  name:                `cas-front-${name}`,
  script:              'npm',
  args:                'start',
  cwd:                 `${ROOT}/apps/${dir}`,
  env:                 { ...process.env, PORT: String(port) },
  instances:           1,
  exec_mode:           'fork',
  watch:               false,
  max_memory_restart:  '1024M',
  autorestart:         true,
  restart_delay:       5000,
});

module.exports = {
  apps: [
    // Backend (12 servicos Node)
    node('gateway',          process.env.PORT_GATEWAY || 3002, 'gateway'),
    node('auth-svc',         process.env.PORT_AUTH    || 3010, 'auth-svc'),
    node('vault-svc',        process.env.PORT_VAULT   || 3020, 'vault-svc'),
    node('seller-svc',       process.env.PORT_SELLER  || 3011, 'seller-svc'),
    node('product-svc',      process.env.PORT_PRODUCT || 3012, 'product-svc'),
    node('qa-svc',           process.env.PORT_QA      || 3013, 'qa-svc'),
    node('order-svc',        process.env.PORT_ORDER   || 3015, 'order-svc'),
    node('payment-svc',      process.env.PORT_PAYMENT || 3016, 'payment-svc'),
    node('review-svc',       process.env.PORT_REVIEW  || 3017, 'review-svc'),
    node('notification-svc', process.env.PORT_NOTIFICATION || 3018, 'notification-svc'),
    node('search-svc',       process.env.PORT_SEARCH  || 3019, 'search-svc'),
    node('aiops-svc',        process.env.PORT_AIOPS   || 3006, 'aiops-svc'),

    // QA worker Python (precisa de uvicorn no PATH)
    {
      name:                'cas-qa-worker',
      script:              'python',
      args:                '-m uvicorn app.main:app --host 0.0.0.0 --port 3014',
      cwd:                 `${ROOT}/services/qa-worker`,
      interpreter:         'none',
      env:                 { ...process.env, PORT_QA_WORKER: '3014' },
      autorestart:         true,
      max_memory_restart:  '1024M',
    },

    // Frontends
    next('storefront',       3000, 'storefront'),
    next('dashboard-admin',  3001, 'dashboard-admin'),
    next('dashboard-seller', 3003, 'dashboard-seller'),
  ],
};
