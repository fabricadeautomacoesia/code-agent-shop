'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const express = require('express');
const cookieParser = require('cookie-parser');
const { logger, sanitize, errorHandler, startup } = require('@cas/shared');
const { healthcheck } = require('@cas/db-client');

// FIX-WORKER-17 pass 7: valida envs criticas ANTES de listen.
// PG_PASS curta/ausente em prod -> fail-closed (Swarm restart loop = alerta ops).
// JWT secrets ja validados pelo packages/shared/src/jwt.js no module-load.
// VAULT_AES_KEY usado em 2FA encrypt/decrypt - critico.
startup.validateStartupEnv({
  critical: ['PG_PASS', 'VAULT_AES_KEY'],
  minLength: { PG_PASS: 12, VAULT_AES_KEY: 64 },
});

const log = logger.child({ svc: 'auth-svc' });
const app = express();
const PORT = parseInt(process.env.PORT_AUTH || '3010', 10);

app.disable('x-powered-by');
// FIX-WORKER-6 (CRITICAL): trust proxy=1 para req.ip ler X-Forwarded-For do gateway.
// SEM ISSO, fail2ban via req.ip recebia o IP do gateway (interno Swarm) em vez do
// IP real do atacante. 5 logins falhos por DIA banhavam TODOS os usuarios da plataforma.
app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());
app.use(sanitize.middleware());

// FIX-WORKER-12 pass 3: alias /auth/health (gateway reescreve /api/auth/* -> /auth/*)
const _healthHandler = async (_req, res) => res.json({ ok: true, db: await healthcheck() });
app.get('/health', _healthHandler);
app.get('/auth/health', _healthHandler);

app.use('/auth', require('./routes/auth'));
app.use('/auth/2fa', require('./routes/two-factor'));
app.use('/auth/me', require('./routes/me'));

app.use((req, res) => res.status(404).json({ error: 'route_not_found', path: req.originalUrl }));
app.use(errorHandler.errorMiddleware);

const server = app.listen(PORT, () => log.info({ port: PORT }, '[auth-svc] listening'));
['SIGINT','SIGTERM'].forEach((s) => process.on(s, () => { log.warn('[auth-svc] shutdown'); server.close(() => process.exit(0)); }));
