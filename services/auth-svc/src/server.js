'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const express = require('express');
const cookieParser = require('cookie-parser');
const { logger, sanitize, errorHandler } = require('@cas/shared');
const { healthcheck } = require('@cas/db-client');

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

app.get('/health', async (_req, res) => res.json({ ok: true, db: await healthcheck() }));

app.use('/auth', require('./routes/auth'));
app.use('/auth/2fa', require('./routes/two-factor'));
app.use('/auth/me', require('./routes/me'));

app.use((req, res) => res.status(404).json({ error: 'route_not_found', path: req.originalUrl }));
app.use(errorHandler.errorMiddleware);

const server = app.listen(PORT, () => log.info({ port: PORT }, '[auth-svc] listening'));
['SIGINT','SIGTERM'].forEach((s) => process.on(s, () => { log.warn('[auth-svc] shutdown'); server.close(() => process.exit(0)); }));
