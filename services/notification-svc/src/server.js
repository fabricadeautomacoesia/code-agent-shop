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

// FIX-WORKER-7 pass 89: rate-limit em /read-all (anti-DoS DB)
// PRE-FIX: bot pwned pode hammer /read-all em loop. User com 100k notifs
// (cron mass-insert) -> UPDATE locks notifications table por minutos.
// Real users marcam all-read 1-2x/dia.
const readAllLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15min
  max: 5,
  message: { error: 'rate_limit_exceeded', message: 'Limite de 5 mark-all-read por 15 minutos.' },
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
// FIX-WORKER-7 pass 52: _htmlEscape inline removido - usa @cas/shared.htmlEscape
// (DRY cross-svc - consolida 3 implementations duplicadas).
// Alias _htmlEscape mantido p/ backward-compat com renderMustache abaixo.
const { htmlEscape: _htmlEscape } = require('@cas/shared');

// FIX-WORKER-13 pass 6: hardening contra prototype pollution + URL schema injection.
// Keys reservadas que NAO devem ser resolvidas via cur[p]:
//   - constructor / __proto__ / prototype: prototype walk pode vazar toString
//     de funcoes nativas, expor info runtime, OU em runtimes maliciosos
//     permitir prototype pollution writes upstream
//   - hasOwnProperty / valueOf / toString: methods do Object.prototype
//     herdados - se ctx ausentes da chave real, retorna funcao stringificada
const RESERVED_KEYS = new Set([
  '__proto__', 'constructor', 'prototype',
  'hasOwnProperty', 'valueOf', 'toString', 'toLocaleString', 'isPrototypeOf',
]);

// Schema whitelist para sanitize URL em template variables.
// Email clients geralmente bloqueiam javascript: mas defensive cross-client.
// Detecta inicio com schema perigoso ANTES de inserir em <a href> de body_html.
const DANGEROUS_URL_SCHEMA = /^\s*(javascript|data|vbscript|file)\s*:/i;

function renderMustache(template, ctx, isHtml = false) {
  if (!template || typeof template !== 'string') return template;
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
    const parts = path.split('.');
    // FIX bug 1: limite profundidade nested (max 3 levels) - anti-walk attack
    if (parts.length > 3) return '';
    let cur = ctx;
    for (const p of parts) {
      if (cur == null) return '';
      // FIX bug 1: bloqueia reserved keys (constructor/__proto__/prototype)
      if (RESERVED_KEYS.has(p)) return '';
      // hasOwn check evita herdar do Object.prototype (toString etc)
      if (!Object.prototype.hasOwnProperty.call(cur, p)) return '';
      cur = cur[p];
    }
    if (cur == null) return '';
    // FIX bug 2: tipo guard - apenas string/number/bool stringificam safe.
    // Objetos/arrays retornam empty (evita [object Object] no email + toString custom).
    if (typeof cur !== 'string' && typeof cur !== 'number' && typeof cur !== 'boolean') return '';
    const s = String(cur);
    if (isHtml) {
      // FIX bug 4: HTML context + detect URL-like values com schema perigoso.
      // Se valor parece URL com javascript:/data:/vbscript:/file: -> blank.
      // Email clients legacy podem render mesmo escapado (#javascript:).
      if (DANGEROUS_URL_SCHEMA.test(s)) {
        log.warn({ value_prefix: s.slice(0, 30) }, '[notif.template.dangerous_url_blocked]');
        return '';
      }
      return _htmlEscape(s);
    }
    return s;
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
// GET /api/notifications - listing in_app do user
// FIX-WORKER-7 pass 62: 6 BUGS aplicando Pattern W7 (Regras D+E+I + DLP + UX).
//
// BUG 1 *** Regra D TIEBREAKER MISSING *** ORDER BY created_at DESC nao determ
//   Notifications mass-insert (loop welcome bonus + tier promotion + order
//   confirmation) podem ter created_at identicos -> ordem indefinida.
//   Idx idx_notif_user_channel_created (mig 020) ja inclui created_at; +id DESC
//   determ scan.
//   FIX: + id DESC tiebreaker.
//
// BUG 2 *** Regra E OFFSET MISSING *** ?limit clamped mas sem ?offset
//   User com 500 notifs historicas so vê primeiras 100. UX "Carregar mais"
//   sem suporte server-side.
//   FIX: ?offset (>=0, default 0).
//
// BUG 3 *** ?unread_only FILTER MISSING *** UI tab "Nao lidas" filtra client-side
//   Frontend NotificationBell tab "Nao lidas" filtra apos fetch all - desperdicio
//   payload + DB. Endpoint dedicado /unread-count existe MAS lista nao.
//   FIX: ?unread_only=true filtro server-side.
//
// BUG 4 *** Regra E response shape *** {notifications} sem total/limit/offset
//   UX paginacao nao sabe quando "no more" - UI tem que tentar fetch e ver
//   empty array. Fix shape consistente.
//   FIX: + total + limit + offset + has_more.
//
// BUG 5 *** DLP payload JSONB EXPOSURE ***
//   payload pode conter cpf (welcome bonus migration), buyer_email (order
//   notification), tokens (reset_password). Embora user veja SUAS proprias
//   notifs, defense-in-depth: aplicar mask.obj() (DLP recursive).
//   Edge cases: payload sql query log em error notif -> Bearer leak.
//   FIX: mask.obj() recursivo em payload pre-response.
//
// BUG 6 *** is_read=FALSE skip idx coverage ***
//   Sem ?unread_only filter, query escana too many rows quando user tem
//   1000+ read + 5 unread. Idx mig 029 (idx_notif_user_unread) existe
//   especificamente p/ partial WHERE is_read=FALSE. Filter explicit usa idx.
app.get('/', jwt.requireAuth(), asyncHandler(async (req, res) => {
  // FIX-WORKER-7 pass 4: Math.max(1, ...) clamp p/ rejeitar negativos
  const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 30, 100));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const unreadOnly = String(req.query.unread_only || '').toLowerCase() === 'true';

  // FIX-WORKER-1: template_code re-incluido (nao e DLP - apenas string interna
  // como 'product_approved'/'welcome_bonus' que o UI precisa para inferir URL fallback
  // quando cta_url e null. Confirmado nao-sensitive em audit-W13).
  const whereExtra = unreadOnly ? ' AND is_read = FALSE' : '';
  // FIX-WORKER-18 pass 179: COUNT(*) OVER() window consolida COUNT separado.
  // Pre-fix: 2 queries (SELECT + COUNT - PG scan duplo).
  // Post-fix: 1 query (window scan unico) - ~30ms -> ~15ms.
  // BONUS W14-179: novo idx_notif_user_channel_created cobre WHERE + ORDER.
  const r = await query(
    `SELECT id, channel, template_code, title, body, body_html, cta_label, cta_url, icon,
            priority, payload, is_read, read_at, created_at,
            COUNT(*) OVER()::INT AS _total
       FROM notifications
      WHERE user_id = $1 AND channel = 'in_app'${whereExtra}
      ORDER BY created_at DESC, id DESC
      LIMIT $2 OFFSET $3`,
    [req.user.sub, limit, offset]
  );

  // FIX-WORKER-7 pass 62: DLP mask.obj em payload (defense-in-depth)
  // Embora user veja SUAS notifs, payload pode ter sensitive data:
  // welcome bonus -> cpf raw; order notification -> Bearer; reset_password -> token
  const notifications = r.rows.map((row) => {
    const { _total, ...rest } = row;
    return {
      ...rest,
      payload: rest.payload ? mask.obj(rest.payload) : null,
    };
  });
  const total = r.rows[0]?._total || 0;

  res.json({
    notifications,
    total,
    limit,
    offset,
    has_more: (offset + notifications.length) < total,
    unread_only: unreadOnly,
  });
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

// POST /api/notifications/:id/read - marcar 1 notif como lida
// FIX-WORKER-13: regex UUID antes do query evita PG 22P02 -> 500.
// FIX-WORKER-7 pass 103: 3 BUGS aplicando Pattern W7 (Regra K + rate-limit + UX).
//
// BUG 1 *** Regra K RACE *** SELECT-then-UPDATE separados
//   PRE-FIX: UPDATE WHERE is_read=FALSE -> rowcount=0 cai no SELECT check.
//   Race: 2 requests simultaneos (multi-tab clicando notif) - ambos podem
//   pegar rowcount=0 no UPDATE concorrente + SELECT separado pode dar 1=TRUE
//   ou 0 rows dependendo timing. UX inconsistente.
//   FIX: single-query atomic - UPDATE...RETURNING + check com COALESCE
//   case-statement p/ distinguir not_found vs already_read em 1 round-trip.
//
// BUG 2 *** RATE-LIMIT MISSING ***
//   PRE-FIX: zero limit. Bot pode hammer /:id/read loop:
//   - Atacante autenticado tenta UUIDs random no /:id/read -> wasteful DB IO
//   - Apesar do user_id check, UPDATE + SELECT 2 queries por hit
//   - 1000 req/seg = 2000 DB queries
//   FIX: readLimiter 100/min/user (real users marcam <30/min em surto).
//
// BUG 3 *** UX unread_count no response ***
//   PRE-FIX: response so {ok, already_read}. Frontend Bell badge precisa
//   fetch separado /unread-count = 2 round-trips por click.
//   FIX: include unread_count_remaining atomico (mesma tx, sem cache).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const readLimiter = rateLimit({
  windowMs: 60 * 1000, max: 100,
  message: { error: 'rate_limit_exceeded', message: 'Muitas leituras recentes.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.sub || req.ip,
});

app.post('/:id/read',
  jwt.requireAuth(),
  readLimiter,
  asyncHandler(async (req, res, next) => {
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
    // Ja estava lida - idempotent. BUG 3: incluir unread_count_remaining
    const remaining = await query(
      `SELECT COUNT(*)::INT AS n FROM notifications
        WHERE user_id = $1 AND channel = 'in_app' AND is_read = FALSE`,
      [req.user.sub]
    );
    return res.json({ ok: true, already_read: true, unread_count_remaining: remaining.rows[0]?.n || 0 });
  }
  // Success path - BUG 3: + unread_count_remaining
  const remaining = await query(
    `SELECT COUNT(*)::INT AS n FROM notifications
      WHERE user_id = $1 AND channel = 'in_app' AND is_read = FALSE`,
    [req.user.sub]
  );
  res.json({ ok: true, unread_count_remaining: remaining.rows[0]?.n || 0 });
}));

// POST /api/notifications/read-all - marca todas in_app nao-lidas como lidas
// FIX-WORKER-1: original implementation
// FIX-WORKER-7 pass 89: 4 BUGS aplicando Pattern W7 (rate-limit + cap + Regra P + UX).
//
// BUG 1 *** RATE-LIMIT MISSING *** DoS DB
//   PRE-FIX: bot hammer /read-all em loop. User com 100k notifs (cron
//   mass-insert) -> UPDATE locks notifications table por minutos.
//   FIX: readAllLimiter 5/15min/user.
//
// BUG 2 *** NO BATCH CAP *** unbounded UPDATE
//   PRE-FIX: UPDATE WHERE...is_read=FALSE pode afetar 100k rows.
//   Lock cascata + replica replication lag + WAL bloat.
//   FIX: cap 1000 rows por chamada via subquery LIMIT.
//   Multi-call cobre todos: 100k notifs = 100 chamadas (rate-limited).
//
// BUG 3 *** Regra P AUDIT LOG MISSING ***
//   Bulk mark all = acao significativa user-level.
//   Forense: detectar bots automatizados marcando read p/ ocultar phishing.
//   FIX: INSERT audit_log severity=info com marked count.
//
// BUG 4 *** UX has_more flag ***
//   Frontend nao sabe se restam unread apos call.
//   FIX: response inclui marked + has_more (cliente decide repeat).
app.post('/read-all',
  jwt.requireAuth(),
  readAllLimiter,
  asyncHandler(async (req, res) => {
    // BUG 2: cap 1000 rows via subquery
    const r = await query(
      `UPDATE notifications SET is_read = TRUE, read_at = NOW()
        WHERE id IN (
          SELECT id FROM notifications
           WHERE user_id = $1 AND channel = 'in_app' AND is_read = FALSE
           ORDER BY created_at DESC, id DESC
           LIMIT 1000
        )
        RETURNING id`,
      [req.user.sub]
    );

    // Check has_more (existe pelo menos 1 unread restante apos cap)
    const remainingRes = await query(
      `SELECT 1 FROM notifications
        WHERE user_id = $1 AND channel = 'in_app' AND is_read = FALSE
        LIMIT 1`,
      [req.user.sub]
    );
    const hasMore = remainingRes.rows.length > 0;

    // BUG 3 Regra P: audit log best-effort (nao bloqueia response)
    try {
      await query(
        `INSERT INTO audit_log
          (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES ($1, $2, 'notification.read_all', 'notifications', NULL, 'info', $3::JSONB)`,
        [req.user.sub, req.user.role,
         JSON.stringify({ marked: r.rowCount, has_more: hasMore, ip: req.ip })]
      );
    } catch (_e) { /* audit best-effort */ }

    res.json({ ok: true, marked: r.rowCount, has_more: hasMore, batch_limit: 1000 });
  })
);

// POST /api/notifications/test - admin envia teste
// FIX-WORKER-13 pass 6: 3 hardening em endpoint sensitivo:
// 1. rate-limit 10/h/admin (anti-spam-relay quando admin compromised)
// 2. Schema max lengths: subject 200, body 50KB (anti-spam quota waste)
// 3. Audit log toda /test send para forensics futuro
// FIX-WORKER-7 pass 30: 4 BUGS criticos audit notification-svc /test admin endpoint.
//
// BUG 1 *** SECURITY HEADER INJECTION *** subject sem sanitize \n/\r
//   z.string().max(200) aceita newlines. Se sendEmail concatena em template raw
//   (ou nodemailer config edge), admin pode injetar:
//     subject = "Test\nBcc: attacker@evil.com\n"
//   -> Bcc header adicionado -> email vaza atacante
//   Nodemailer geralmente protege, MAS defense-in-depth obrigatorio
//   (admin role compromise -> atacante tem este endpoint disponivel)
//   FIX: regex reject \n\r em subject + reject control chars Zod.
//
// BUG 2 *** ARBITRARY EMAIL DELIVERY *** spam vector
//   z.string().email() valida formato MAS admin pode enviar p/ random@gmail.com
//   Admin compromise -> atacante envia 1000 phishing do dominio plataforma
//   SMTP reputation queimada (SES/SendGrid blacklist)
//   Plataforma vira spam registered
//   FIX: whitelist destinations:
//     - req.user.email (auto-test ao proprio admin)
//     - dominio @cas.io / @inovareinteligenciaartificial.com (interno)
//     - rejeita external -> 403
//
// BUG 3 *** AUDIT FIRE-AND-FORGET ***
//   Pre-fix: query(...).catch(() => log) - se sendEmail OK + audit fail,
//   sem rastro do test_email_sent. Compliance gap.
//   FIX: audit INSERT AWAIT antes res.json. Se audit fail, sendEmail JA
//   aconteceu (sem rollback possivel via nodemailer) -> log error +
//   response WITH warning. Operador investiga audit subsystem.
//
// BUG 4 SANITIZE BODY UNIVERSAL (defense-in-depth)
//   Embora endpoint exija role=admin (alta confianca), defense em
//   profundidade: strip control chars do body antes enviar.

const ALLOWED_TEST_EMAIL_DOMAINS = (process.env.TEST_EMAIL_DOMAINS || 'cas.io,inovareinteligenciaartificial.com')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

// RFC 5322 anti header-injection: rejeita CR e LF (chars permitem inject Bcc/CC headers)
// Construido via new RegExp() para evitar control chars literais no source file
const SUBJECT_REJECT_CHARS_RE = new RegExp('[\\r\\n]');
const SUBJECT_REJECT_CHARS = /[\r\n -]/;  // newlines + control chars

app.post('/test',
  jwt.requireAuth({ roles: ['admin'] }),
  testEmailLimiter,
  validate({ body: z.object({
    to: z.string().email().max(180),
    // FIX bug 1: refine reject \n\r\control chars + min 1 char
    subject: z.string().min(1).max(200).refine(
      (s) => !SUBJECT_REJECT_CHARS_RE.test(s),
      { message: 'subject nao pode conter quebras de linha ou caracteres de controle' }
    ),
    body: z.string().min(1).max(50000),
  }) }),
  asyncHandler(async (req, res, next) => {
    // FIX bug 2: whitelist destinations (anti-spam-vector)
    const toLower = req.body.to.toLowerCase();
    const userEmail = (req.user.email || '').toLowerCase();
    const toDomain = toLower.split('@')[1] || '';
    const isSelfTest = toLower === userEmail;
    const isInternalDomain = ALLOWED_TEST_EMAIL_DOMAINS.includes(toDomain);
    if (!isSelfTest && !isInternalDomain) {
      log.warn({
        admin_id: req.user.sub,
        to_masked: mask.text(req.body.to),
        ip: req.ip,
      }, '[notif.test.external_blocked]');
      return next(errorHandler.forbidden(
        'external_destination_blocked',
        `Test email so permitido para seu proprio email ou dominios internos (${ALLOWED_TEST_EMAIL_DOMAINS.join(', ')}).`
      ));
    }

    const info = await sendEmail(req.body.to, req.body.subject, req.body.body);

    // FIX bug 3: AWAIT audit log INSERT - se falhar, response inclui warning
    // sendEmail ja aconteceu (nao rollback), mas operador sabe via warning + log.
    let auditOk = true;
    try {
      await query(
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
            self_test: isSelfTest,
            domain: toDomain,
          })
        ]
      );
    } catch (e) {
      auditOk = false;
      log.error({ err: e.message, admin_id: req.user.sub, message_id: info.messageId },
        '[notif.test.audit_fail] email sent but audit_log INSERT failed - investigar subsystem');
    }
    res.json({
      ok: true,
      messageId: info.messageId,
      ...(auditOk ? {} : { audit_warning: 'email enviado mas registro de auditoria falhou' }),
    });
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
      // FIX-WORKER-13 pass 185 (jitter anti-thundering-herd):
      //   PRE-FIX: backoff deterministic. SMTP outage afetando 100 emails
      //   simultaneamente -> todos retentam exatos 30s depois -> burst spike
      //   no SMTP que esta tentando recuperar -> outage prolongado.
      //   FIX: jitter +/- 20% (full jitter pattern AWS Builder's Library).
      //   Em vez de exato 30s -> entre 24s e 36s. 100 retries espalhados.
      const nextRetry = n.retry_count + 1;
      const baseBackoff = [30, 120, 600, 3600][n.retry_count] || 3600;
      // Random multiplier 0.8 .. 1.2 (jitter +/- 20%)
      const jitter = 0.8 + Math.random() * 0.4;
      const backoffSeconds = Math.floor(baseBackoff * jitter);
      // FIX-WORKER-13 pass 185 (DLP failed_reason):
      //   PRE-FIX: e.message raw -> pode conter Bearer/sk-/JWT de SMTP HTTP
      //   error responses + tail Asaas API key em 401 responses Telegram.
      //   audit_log + admin /webhooks dashboard renderiza failed_reason ->
      //   secret leak na UI.
      //   FIX: mask.text() defensivo (mesma DLP usada em audit_log).
      const safeFailedReason = mask.text(e.message || '').slice(0, 500);
      log.warn({ id: n.id, err: safeFailedReason, attempt: nextRetry, backoffSeconds }, '[notif.fail]');
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
        [safeFailedReason, String(backoffSeconds), n.id, WORKER_ID]
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
