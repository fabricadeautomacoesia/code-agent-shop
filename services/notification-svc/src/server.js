'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const express = require('express');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { query } = require('@cas/db-client');
const { logger, sanitize, errorHandler, asyncHandler, validate, jwt, mask } = require('@cas/shared');

// FIX-WORKER-13 pass 6: rate-limit em /test - era endpoint admin sem QUALQUER limit.
// Admin compromised (XSS/session hijack) pode disparar emails ilimitados para
// qualquer destino -> built-in email-bombing facility + spam relay anonymous-ish.
// 10 emails de teste/hora/admin = uso legitimo (debugging templates novos).
const testEmailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1h
  max: 10,
  message: { error: 'rate_limit_exceeded', message: 'Limite de 10 emails de teste por hora.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.sub || req.ip,
});

const log = logger.child({ svc: 'notification-svc' });
const app = express();
const PORT = parseInt(process.env.PORT_NOTIFICATION || '3018', 10);

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(sanitize.middleware());

// ============================================================
// Transports
// ============================================================
const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  secure: process.env.SMTP_SECURE === 'true',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

const FROM = process.env.SMTP_FROM || 'Code & Agent Shop <no-reply@code-agent-shop.com>';

// FIX-WORKER-13: Mustache-like render simples. Substitui {{var}} ou {{nested.path}}.
// Suporta nested via dot notation (ex {{user.email}}).
// Var ausente vira string vazia (evita 'undefined' literal no email).
// FIX-WORKER-13 pass 2 (XSS): isHtml=true escapa < > & " ' / antes de injetar.
// Antes: comment dizia "Anti-XSS minimo" mas codigo NAO escapava nada.
// Vetor real: seller cria produto title="X<script>alert(1)</script>" -> notification
// payload.title -> renderMustache body_html -> <script> raw no email -> XSS no Gmail
// preview (alguns clients render <script>; outros so img/iframe mas o vetor existe).
function _htmlEscape(s) {
  return String(s).replace(/[&<>"'/]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '/': '&#x2F;',
  })[c]);
}
function renderMustache(template, ctx, isHtml = false) {
  if (!template || typeof template !== 'string') return template;
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
    const parts = path.split('.');
    let cur = ctx;
    for (const p of parts) {
      if (cur == null) return '';
      cur = cur[p];
    }
    if (cur == null) return '';
    const s = String(cur);
    return isHtml ? _htmlEscape(s) : s;
  });
}

// FIX-WORKER-13 pass 5: defesa simetrica ao Telegram - se SMTP nao configurado,
// throw cedo em vez de nodemailer dar erro confuso "ECONNREFUSED 127.0.0.1:587".
// Outbox processor pega no catch + retry/fail backoff exponencial existente.
async function sendEmail(to, subject, body, html) {
  if (!process.env.SMTP_HOST) {
    throw new Error('email_not_configured: SMTP_HOST ausente');
  }
  if (!to) {
    throw new Error('email_missing_recipient: user sem coluna email no DB');
  }
  return mailer.sendMail({ from: FROM, to, subject, text: body, html: html || undefined });
}

// FIX-WORKER-13 pass 5: 2 bugs criticos resolvidos no envio Telegram.
// BUG-A: env vars ausentes -> retornava null silenciosamente. processOutbox
//   nao detectava isso e marcava notif como 'sent'. Notifs Telegram somem.
//   Admin pensava que recebia alertas mas nao chegavam.
// BUG-B: HTTP error (token revogado, bot bloqueado, chat invalido) tambem
//   passava silencioso porque r.json() nao throw em status 4xx/5xx.
//   Telegram retorna {ok:false, error_code:401, description:"Unauthorized"}
//   mas codigo retornava o JSON normalmente -> notif marcada 'sent' sem envio.
// FIX: throw em ambos os casos -> outbox processor pega no catch e retry/fail
//   com backoff exponencial existente.
async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) {
    throw new Error('telegram_not_configured: TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID ausente');
  }
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: message.slice(0, 4000), parse_mode: 'Markdown' }),
    signal: AbortSignal.timeout(10000),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.ok === false) {
    const desc = body.description || `HTTP ${r.status}`;
    throw new Error(`telegram_api_error: ${desc}`);
  }
  return body;
}

// ============================================================
// Endpoints
// ============================================================
app.get('/health', (_req, res) => res.json({
  ok: true, svc: 'notification-svc',
  channels: { email: !!process.env.SMTP_HOST, telegram: !!process.env.TELEGRAM_BOT_TOKEN }
}));

// GET /api/notifications - bandeja in-app do user
// FIX-WORKER-13: SELECT explicit nao expoe campos internos do outbox processor:
// - locked_by/locked_at (worker mutex), next_retry_at/retry_count/failed_reason
//   (state machine), sent_status/sent_at (irrelevante para in_app), template_code
//   (interno), user_id (redundante, ja eh do user authed)
// Reduz tambem payload size por notif (de ~1.3kb para ~0.5kb).
app.get('/', jwt.requireAuth(), asyncHandler(async (req, res) => {
  // FIX-WORKER-7 pass 4: Math.max(1, ...) clamp p/ rejeitar negativos
  const lim = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 30, 100));
  // FIX-WORKER-1: template_code re-incluido (nao e DLP - apenas string interna
  // como 'product_approved'/'welcome_bonus' que o UI precisa para inferir URL fallback
  // quando cta_url e null. Confirmado nao-sensitive em audit-W13).
  const r = await query(
    `SELECT id, channel, template_code, title, body, body_html, cta_label, cta_url, icon,
            priority, payload, is_read, read_at, created_at
       FROM notifications
      WHERE user_id = $1 AND channel = 'in_app'
      ORDER BY created_at DESC LIMIT $2`,
    [req.user.sub, lim]
  );
  res.json({ notifications: r.rows });
}));

// FIX-WORKER-13 pass 4: GET /api/notifications/unread-count
// Frontend NotificationBell calculava `notifs.filter(!is_read).length` no client,
// obrigando fetch de TODAS as 30 notifs (~15kb payload) so para mostrar badge "5+".
// Endpoint dedicado retorna SO o numero (16 bytes) -> permite poll 30s sem custo.
// Idx idx_notif_user_channel_created (mig 020) garante <2ms query.
app.get('/unread-count', jwt.requireAuth(), asyncHandler(async (req, res) => {
  const r = await query(
    `SELECT COUNT(*)::INT AS count
       FROM notifications
      WHERE user_id = $1 AND channel = 'in_app' AND is_read = FALSE`,
    [req.user.sub]
  );
  res.json({ count: r.rows[0]?.count || 0 });
}));

// POST /api/notifications/:id/read
// FIX-WORKER-13: regex UUID antes do query evita PG 22P02 -> 500 quando id malformado.
// Antes: silencioso ok:true mesmo se nenhuma row foi afetada (notif inexistente
// ou de outro user). Agora retorna 404 se UPDATE 0 rows.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
app.post('/:id/read', jwt.requireAuth(), asyncHandler(async (req, res, next) => {
  if (!UUID_RE.test(req.params.id)) {
    return next(errorHandler.notFound('notification_not_found'));
  }
  const r = await query(
    `UPDATE notifications SET is_read = TRUE, read_at = NOW()
      WHERE id = $1::UUID AND user_id = $2::UUID AND is_read = FALSE
      RETURNING id`,
    [req.params.id, req.user.sub]
  );
  if (!r.rows.length) {
    // Verifica se notif existe mas ja estava lida (idempotent OK)
    const check = await query(
      `SELECT is_read FROM notifications WHERE id = $1::UUID AND user_id = $2::UUID`,
      [req.params.id, req.user.sub]
    );
    if (!check.rows.length) return next(errorHandler.notFound('notification_not_found'));
    // Ja estava lida - idempotent
    return res.json({ ok: true, already_read: true });
  }
  res.json({ ok: true });
}));

// FIX-WORKER-1: POST /api/notifications/read-all - marca todas in_app nao-lidas como lidas
app.post('/read-all', jwt.requireAuth(), asyncHandler(async (req, res) => {
  const r = await query(
    `UPDATE notifications SET is_read = TRUE, read_at = NOW()
      WHERE user_id = $1 AND channel = 'in_app' AND is_read = FALSE
      RETURNING id`,
    [req.user.sub]
  );
  res.json({ ok: true, marked: r.rowCount });
}));

// POST /api/notifications/test - admin envia teste
// FIX-WORKER-13 pass 6: 3 hardening em endpoint sensitivo:
// 1. rate-limit 10/h/admin (anti-spam-relay quando admin compromised)
// 2. Schema max lengths: subject 200, body 50KB (anti-spam quota waste)
// 3. Audit log toda /test send para forensics futuro
app.post('/test',
  jwt.requireAuth({ roles: ['admin'] }),
  testEmailLimiter,
  validate({ body: z.object({
    to: z.string().email().max(180),
    subject: z.string().min(1).max(200),
    body: z.string().min(1).max(50000),
  }) }),
  asyncHandler(async (req, res) => {
    const info = await sendEmail(req.body.to, req.body.subject, req.body.body);
    // Audit log async (nao bloqueia response)
    query(
      `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
       VALUES ($1, $2, $3, $4, $5, $6, $7::JSONB)`,
      [
        req.user.sub, req.user.role, 'notification.test_email_sent',
        'email', null, 'info',
        JSON.stringify({
          to_masked: mask.text(req.body.to),
          subject: req.body.subject.slice(0, 100),
          message_id: info.messageId,
          ip: req.ip,
        })
      ]
    ).catch((e) => log.warn({ err: e.message }, '[audit.fail]'));
    res.json({ ok: true, messageId: info.messageId });
  })
);

// ============================================================
// PROCESSOR (worker cron) - WORKER 13 FIX
// ============================================================
const WORKER_ID = `${process.env.HOSTNAME || 'notif'}-${process.pid}`;

// Recupera locks orfaos (worker crashou): a cada minuto, libera linhas locked > 5min.
async function reclaimOrphanLocks() {
  await query(
    `UPDATE notifications SET locked_by = NULL, locked_at = NULL
      WHERE locked_at IS NOT NULL AND locked_at < NOW() - INTERVAL '5 minutes'`
  );
}

async function processOutbox() {
  // FIX-13-1 (race condition): claim atomico via UPDATE ... RETURNING.
  // Apenas um worker (entre varias replicas) consegue setar locked_by.
  const claimed = await query(
    `UPDATE notifications
        SET locked_by = $1, locked_at = NOW()
      WHERE id IN (
        SELECT id FROM notifications
         WHERE sent_status = 'pending'
           AND channel IN ('email','telegram')
           AND retry_count < 5
           AND next_retry_at <= NOW()
           AND locked_by IS NULL
         ORDER BY priority DESC, created_at ASC
         LIMIT 25
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id`,
    [WORKER_ID]
  );

  if (!claimed.rows.length) return;
  const ids = claimed.rows.map((r) => r.id);

  // Carrega payload completo das linhas claimed
  // FIX-WORKER-7 pass 26 (Regra B): u.deleted_at IS NULL filter.
  // User soft-deleted (admin moderou) NAO deve receber notifications.
  // Edge case: admin banne user por abuso, mas notification pending
  // ja era enviada -> email "Pedido aprovado" para user banido.
  // Trata como sucesso (sent_status='sent') para nao retry infinito -
  // user nao existe mais, nao adianta retry.
  const pending = await query(
    `SELECT n.id, n.user_id, n.channel, n.template_code, n.title, n.body, n.body_html,
            n.priority, n.payload, n.retry_count, u.email, u.full_name, u.locale
       FROM notifications n
       JOIN users u ON u.id = n.user_id AND u.deleted_at IS NULL
      WHERE n.id = ANY($1::uuid[])`,
    [ids]
  );

  // FIX-WORKER-7 pass 26: marca notifs orfas (user deletado entre claim
  // e load) como 'failed' p/ evitar retry infinito + reclaim loop.
  // Diff de IDs claimed vs IDs retornados pelo JOIN.
  const loadedIds = new Set(pending.rows.map((r) => r.id));
  const orphanIds = ids.filter((id) => !loadedIds.has(id));
  if (orphanIds.length) {
    await query(
      `UPDATE notifications
          SET sent_status = 'failed',
              failed_reason = 'user_deleted_or_orphan',
              locked_by = NULL, locked_at = NULL
        WHERE id = ANY($1::uuid[]) AND sent_status = 'pending'`,
      [orphanIds]
    );
    log.warn({ orphan_count: orphanIds.length }, '[outbox.orphan_marked_failed]');
  }

  for (const n of pending.rows) {
    try {
      // FIX-WORKER-13: Mustache-like {{var}} render usando payload + user data.
      // Antes: emails saiam com placeholders literais ({{name}}, {{order_number}}).
      // Agora: substitui antes de enviar. Funciona em title, body e body_html.
      let title = n.title;
      let body = n.body;
      let bodyHtml = n.body_html;
      const hasPlaceholder = (s) => typeof s === 'string' && s.includes('{{');
      if (hasPlaceholder(title) || hasPlaceholder(body) || hasPlaceholder(bodyHtml)) {
        const ctx = {
          name: n.full_name || 'cliente',
          full_name: n.full_name || '',
          email: n.email || '',
          ...(typeof n.payload === 'object' && n.payload ? n.payload : {}),
        };
        title = renderMustache(title || '', ctx);
        body  = renderMustache(body  || '', ctx);
        // FIX-WORKER-13 pass 2 (XSS): isHtml=true escapa HTML antes de injetar no body_html
        bodyHtml = bodyHtml ? renderMustache(bodyHtml, ctx, true) : null;
      }
      // Defense: nunca enviar com title vazio (anti-spam-filter)
      if (!title || !title.trim()) title = '(sem assunto - revise template)';
      if (!body || !body.trim()) body = '(sem conteudo)';

      if (n.channel === 'email') {
        await sendEmail(n.email, title, body, bodyHtml);
      } else if (n.channel === 'telegram') {
        await sendTelegram(`*${title}*\n${body}`);
      }
      // FIX-WORKER-7 pass 26 (Regra N + idempotent guard):
      // UPDATE com WHERE locked_by=worker_id E sent_status='pending'.
      // Cenario que motivou fix:
      //   - Worker A claim notif-1 (retry_count=4, lock=A)
      //   - reclaimOrphanLocks libera lock apos 5min (assume A morto)
      //     mas A esta vivo, em sendEmail SMTP timeout interno longo
      //   - Worker B claim notif-1 (lock=B), envia email com sucesso
      //   - UPDATE B: sent_status='sent', lock=NULL -> OK
      //   - Worker A volta do SMTP, envia email tambem (2o envio ao user!)
      //   - UPDATE A: WHERE id=N (sem guard) -> SOBRESCREVE sent_at + (idempotente status)
      // Email DUPLICADO ao user. UI usuario: "por que recebi 2x?"
      // FIX: WHERE locked_by = $worker_id AND sent_status='pending'
      //   - Worker A volta -> ROWCOUNT=0 (lock ja foi pra B) -> nao envia 2o email
      //     PORQUE: hasta este ponto codigo ja sendEmail acima! Mitigation real:
      //     SELECT FOR UPDATE dentro do tx() do sendEmail seria ideal mas SMTP
      //     pode demorar -> impede paralelismo. Pragmatic: post-send guard
      //     loga warn p/ admin investigar duplicates.
      const upd = await query(
        `UPDATE notifications
            SET sent_status = 'sent', sent_at = NOW(),
                locked_by = NULL, locked_at = NULL
          WHERE id = $1 AND locked_by = $2 AND sent_status = 'pending'
          RETURNING id`,
        [n.id, WORKER_ID]
      );
      if (!upd.rows.length) {
        // Race detected: outro worker tomou o lock (reclaim) e processou.
        // Email JA foi enviado por nos (acima). Loga warn p/ investigacao.
        log.warn({ id: n.id, worker: WORKER_ID, channel: n.channel },
          '[notif.race.duplicate_send] outro worker tomou lock - email duplicado possivelmente enviado');
      } else {
        log.info({ id: n.id, channel: n.channel, to: mask.text(n.email || '') }, '[notif.sent]');
      }
    } catch (e) {
      // FIX-13-2 (backoff): proxima tentativa com delay exponencial.
      // 1->30s, 2->2min, 3->10min, 4->1h, 5->terminal failed
      const nextRetry = n.retry_count + 1;
      const backoffSeconds = [30, 120, 600, 3600][n.retry_count] || 3600;
      log.warn({ id: n.id, err: e.message, attempt: nextRetry, backoffSeconds }, '[notif.fail]');
      // FIX-WORKER-7 pass 26 (Regra N idempotent retry): WHERE guard
      // previne retry_count DOUBLE-INCREMENT em race scenario (worker A
      // e B ambos catch + UPDATE -> retry_count incrementa 2x em 1 falha).
      await query(
        `UPDATE notifications
            SET retry_count = retry_count + 1,
                failed_reason = $1,
                sent_status = CASE WHEN retry_count + 1 >= 5 THEN 'failed' ELSE 'pending' END,
                next_retry_at = NOW() + ($2 || ' seconds')::INTERVAL,
                locked_by = NULL,
                locked_at = NULL
          WHERE id = $3 AND locked_by = $4 AND sent_status = 'pending'`,
        [e.message.slice(0, 500), String(backoffSeconds), n.id, WORKER_ID]
      );
    }
  }
}

// Cron: a cada 30s processa outbox
cron.schedule('*/30 * * * * *', () => processOutbox().catch((e) => log.error({ err: e.message }, '[outbox.err]')));
// Cron: a cada minuto recupera locks orfaos
cron.schedule('* * * * *', () => reclaimOrphanLocks().catch((e) => log.error({ err: e.message }, '[outbox.reclaim_err]')));

// Cron diario: limpeza de notifications antigas (60d)
cron.schedule('0 4 * * *', async () => {
  const r = await query(`DELETE FROM notifications WHERE created_at < NOW() - INTERVAL '60 days' RETURNING id`);
  log.info({ deleted: r.rowCount }, '[notif.cleanup]');
});

app.use((req, res) => res.status(404).json({ error: 'route_not_found' }));
app.use(errorHandler.errorMiddleware);

const server = app.listen(PORT, () => log.info({ port: PORT }, '[notification-svc] listening'));
['SIGINT','SIGTERM'].forEach((s) => process.on(s, () => server.close(() => process.exit(0))));
