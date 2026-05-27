'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const express = require('express');
const crypto = require('node:crypto');
const { z } = require('zod');
const { query, tx } = require('@cas/db-client');
const { logger, sanitize, errorHandler, asyncHandler, validate, jwt, startup } = require('@cas/shared');

// FIX-WORKER-17 pass 7: valida envs criticas ANTES de listen.
// QA_CALLBACK_SECRET obrigatorio (HMAC do worker -> autenticidade de scores).
// QA_RUN_INTERNAL_TOKEN warn (sem ele, /qa/run cai em jwt auth fallback OK).
startup.validateStartupEnv({
  critical: ['PG_PASS'],
  minLength: { PG_PASS: 12, QA_CALLBACK_SECRET: 32 },
  warnIfMissing: ['QA_CALLBACK_SECRET', 'QA_RUN_INTERNAL_TOKEN'],
});

const log = logger.child({ svc: 'qa-svc' });
const app = express();
const PORT = parseInt(process.env.PORT_QA || '3013', 10);

const QA_THRESHOLD = parseFloat(process.env.QA_CONFIDENCE_THRESHOLD || '0.80');
const N8N_URL      = process.env.N8N_WEBHOOK_URL;
const N8N_SECRET   = process.env.N8N_WEBHOOK_SECRET || '';
const WORKER_URL   = process.env.QA_WORKER_URL || `http://tasks.cas_qa-worker:${process.env.PORT_QA_WORKER || 3014}`;
// FIX-WORKER-12 (CRITICAL SEC): segredo p/ assinar callback do n8n/worker.
// Sem isso, qualquer endpoint da internet podia forjar confidence_score=1.0
// e aprovar QUALQUER produto sem QA real.
const QA_CALLBACK_SECRET = process.env.QA_CALLBACK_SECRET || '';
// FIX-WORKER-12 pass 2: token interno para o product-svc disparar /qa/run.
// Sem isso, qualquer um na internet podia POST /qa/run -> trocar status de
// produto para qa_running (DoS de listagem) + spawnar LLM call (denial-of-wallet).
const QA_RUN_INTERNAL_TOKEN = process.env.QA_RUN_INTERNAL_TOKEN || '';
// Para Swarm, callback URL precisa ser o service name (worker isolado nao conhece localhost do qa-svc)
const CALLBACK_BASE = process.env.QA_CALLBACK_BASE_URL || `http://tasks.cas_qa-svc:${PORT}`;

app.disable('x-powered-by');
// FIX-WORKER-12: callback usa raw body para validar HMAC byte-exact antes de parsear
app.use('/qa/callback', express.raw({ type: '*/*', limit: '5mb' }));
app.use(express.json({ limit: '5mb' }));
app.use(sanitize.middleware());

app.get('/health', (_req, res) => res.json({ ok: true, svc: 'qa-svc', worker_url: WORKER_URL, threshold: QA_THRESHOLD }));

// HMAC sign para n8n
function signPayload(body) {
  return crypto.createHmac('sha256', N8N_SECRET).update(JSON.stringify(body)).digest('hex');
}

/**
 * POST /qa/run - disparado pelo product-svc apos submit.
 * Cria product_qa_run + dispara n8n (se configurado) OU chama worker direto.
 *
 * FIX-WORKER-12 pass 2 (CRITICAL): aceita x-internal-token=QA_RUN_INTERNAL_TOKEN
 * (mesh service-to-service do product-svc) OU role admin/staff/service via JWT.
 * Sem isso, antes qualquer um podia POST -> mover produto para status=qa_running
 * (DoS de listagem) + invocar LLM (denial-of-wallet).
 */
function qaRunGuard(req, res, next) {
  const tok = req.headers['x-internal-token'];
  if (QA_RUN_INTERNAL_TOKEN && tok) {
    let valid = false;
    try {
      const a = Buffer.from(String(tok));
      const b = Buffer.from(QA_RUN_INTERNAL_TOKEN);
      valid = a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch { valid = false; }
    if (valid) return next();
    log.warn({ ip: req.ip, ua: req.headers['user-agent'] }, '[qa.run.invalid_internal_token]');
  }
  return jwt.requireAuth({ roles: ['admin', 'staff', 'service'] })(req, res, next);
}

app.post('/qa/run',
  qaRunGuard,
  validate({ body: z.object({
    product_id: z.string().uuid(),
    product_version_id: z.string().uuid().optional(),
    triggered_by: z.string().uuid().optional(),
  })}),
  asyncHandler(async (req, res) => {
    const { product_id, product_version_id, triggered_by } = req.body;

    const p = await query(
      `SELECT id, title, description, kind, package_url, package_hash_sha256, tech_stack,
              api_keys_required, install_instructions, seller_id
         FROM products WHERE id = $1`, [product_id]
    );
    if (!p.rows.length) return res.status(404).json({ error: 'product_not_found' });
    const product = p.rows[0];

    const run = await query(
      `INSERT INTO product_qa_runs (product_id, product_version_id, triggered_by_user_id, verdict, started_at)
       VALUES ($1, $2, $3, 'running', NOW()) RETURNING id`,
      [product_id, product_version_id || null, triggered_by || null]
    );
    const run_id = run.rows[0].id;

    await query(`UPDATE products SET status = 'qa_running', qa_verdict = 'running' WHERE id = $1`, [product_id]);

    res.status(202).json({ ok: true, run_id, message: 'QA disparado' });

    // Processamento assincrono - nao bloqueia resposta
    setImmediate(async () => {
      try {
        const payload = {
          run_id,
          product_id,
          product_version_id: product_version_id || null,
          title: product.title,
          description: product.description,
          kind: product.kind,
          package_url: product.package_url,
          package_hash_sha256: product.package_hash_sha256,
          tech_stack: product.tech_stack,
          api_keys_required: product.api_keys_required,
          install_instructions: product.install_instructions,
          callback_url: `${CALLBACK_BASE}/qa/callback`,
          callback_secret_hint: QA_CALLBACK_SECRET ? 'present' : 'missing',
        };

        // Opcao A: n8n se configurado (orquestracao externa)
        if (N8N_URL) {
          log.info({ run_id, url: N8N_URL }, '[qa.dispatch.n8n]');
          await fetch(N8N_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Signature': signPayload(payload),
              'X-Run-Id': run_id,
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(15000),
          });
          await query(`UPDATE product_qa_runs SET n8n_execution_id = $1 WHERE id = $2`,
            [`pending-${run_id.slice(0, 8)}`, run_id]);
        } else {
          // Opcao B: chamada direta ao worker Python
          log.info({ run_id, url: WORKER_URL }, '[qa.dispatch.worker]');
          await fetch(`${WORKER_URL}/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(300000), // 5 min
          });
        }
      } catch (e) {
        log.error({ run_id, err: e.message }, '[qa.dispatch_failed]');
        await query(
          `UPDATE product_qa_runs SET verdict = 'error', finished_at = NOW(),
                                       reasons = ARRAY[$1] WHERE id = $2`,
          [`dispatch_failed: ${e.message}`, run_id]
        );
        await query(`UPDATE products SET status = 'qa_pending', qa_verdict = 'pending' WHERE id = $1`, [product_id]);
      }
    });
  })
);

/**
 * POST /qa/callback - recebe veredito do n8n OU worker.
 * Aplica gate: confidence >= 0.80 => APPROVED, senao => REJECTED.
 * Se APPROVED + seller_class B => reseta SLA timer.
 *
 * FIX-WORKER-12 (CRITICAL): valida HMAC SHA-256 do body com QA_CALLBACK_SECRET.
 * Sem isso, antes qualquer endpoint da internet podia forjar callback com
 * confidence_score=1.0 e aprovar qualquer produto sem QA real -> trigger de
 * cadeia: order_paid -> license_key -> download. Fraude direta.
 */
function qaCallbackGuard(req, res, next) {
  if (!QA_CALLBACK_SECRET) {
    log.error('[qa.callback.misconfigured] QA_CALLBACK_SECRET nao definido');
    return res.status(503).json({ error: 'callback_not_configured' });
  }
  // req.body aqui eh Buffer (express.raw montado em /qa/callback acima)
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
  const sig = req.headers['x-signature'] || '';
  const expected = crypto.createHmac('sha256', QA_CALLBACK_SECRET).update(raw).digest('hex');
  let valid = false;
  try {
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(expected, 'hex');
    valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { valid = false; }
  if (!valid) {
    log.warn({ ip: req.ip, ua: req.headers['user-agent'] }, '[qa.callback.invalid_signature]');
    return res.status(401).json({ error: 'invalid_signature' });
  }
  // Apos validar, parseia para o handler downstream
  try {
    req.body = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'invalid_json' });
  }
  next();
}

app.post('/qa/callback',
  qaCallbackGuard,
  validate({ body: z.object({
    run_id: z.string().uuid(),
    confidence_score: z.number().min(0).max(1),
    sintaxe_ok: z.boolean().optional(),
    resolves_problem: z.boolean().optional(),
    is_functional: z.boolean().optional(),
    reasons: z.array(z.string()).optional(),
    suggestions: z.array(z.string()).optional(),
    llm_provider: z.string().optional(),
    llm_model: z.string().optional(),
    tokens_input: z.number().int().optional(),
    tokens_output: z.number().int().optional(),
    cost_usd_cents: z.number().int().optional(),
    duration_ms: z.number().int().optional(),
    raw_response: z.any().optional(),
  })}),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const approved = b.confidence_score >= QA_THRESHOLD;
    const verdict = approved ? 'approved' : 'rejected';

    await tx(async (c) => {
      // 1. Atualiza run
      await c.query(
        `UPDATE product_qa_runs SET
           verdict = $1, confidence_score = $2,
           sintaxe_ok = $3, resolves_problem = $4, is_functional = $5,
           reasons = $6, suggestions = $7,
           llm_provider = $8, llm_model = $9,
           tokens_input = $10, tokens_output = $11,
           cost_usd_cents = $12, duration_ms = $13,
           raw_response = $14::JSONB, finished_at = NOW()
         WHERE id = $15`,
        [verdict, b.confidence_score, b.sintaxe_ok, b.resolves_problem, b.is_functional,
         b.reasons || null, b.suggestions || null, b.llm_provider, b.llm_model,
         b.tokens_input || null, b.tokens_output || null, b.cost_usd_cents || null,
         b.duration_ms || null, JSON.stringify(b.raw_response || {}), b.run_id]
      );

      const r = await c.query(`SELECT product_id, product_version_id FROM product_qa_runs WHERE id = $1`, [b.run_id]);
      if (!r.rows.length) return;
      const { product_id, product_version_id } = r.rows[0];

      // 2. Atualiza produto
      if (approved) {
        await c.query(
          `UPDATE products SET
              status = 'approved', qa_verdict = 'approved',
              qa_confidence_score = $1, qa_last_check_at = NOW(),
              approved_at = COALESCE(approved_at, NOW()),
              published_at = COALESCE(published_at, NOW()),
              rejected_reason = NULL,
              qa_reasons = NULL,
              updated_at = NOW()
            WHERE id = $2`, [b.confidence_score, product_id]
        );
        // Reset SLA Classe B (V8: timer SO reseta com aprovado)
        await c.query(
          `UPDATE sellers s SET
              sla_last_upload_at = NOW(),
              sla_next_deadline_at = NOW() + (s.sla_days || ' days')::INTERVAL,
              updated_at = NOW()
            FROM products p
            WHERE p.id = $1 AND p.seller_id = s.id AND s.seller_class = 'class_b' AND s.sla_active = TRUE`,
          [product_id]
        );
        // Incrementa contador de produtos ativos do seller
        await c.query(
          `UPDATE sellers SET total_products_active = total_products_active + 1
             WHERE id = (SELECT seller_id FROM products WHERE id = $1)`, [product_id]
        );
      } else {
        await c.query(
          `UPDATE products SET
              status = 'rejected', qa_verdict = 'rejected',
              qa_confidence_score = $1, qa_last_check_at = NOW(),
              rejected_at = NOW(), rejected_reason = $2,
              qa_reasons = $3, updated_at = NOW()
            WHERE id = $4`,
          [b.confidence_score, (b.reasons || []).join('; ').slice(0, 1000),
           b.reasons || null, product_id]
        );
      }

      // 3. Atualiza version se aplicavel
      if (product_version_id) {
        await c.query(
          `UPDATE product_versions SET
              qa_verdict = $1, qa_confidence_score = $2, qa_reasons = $3
            WHERE id = $4`,
          [verdict, b.confidence_score, b.reasons || null, product_version_id]
        );
      }

      // 4. Notification ao seller
      const u = await c.query(
        `SELECT s.user_id, p.title, u.full_name, u.email
           FROM products p
           JOIN sellers s ON s.id = p.seller_id
           JOIN users u ON u.id = s.user_id
          WHERE p.id = $1`, [product_id]
      );
      if (u.rows.length) {
        const seller = u.rows[0];
        await c.query(
          `INSERT INTO notifications (user_id, channel, template_code, title, body, payload, priority)
           VALUES ($1, 'email', $2, $3, $4, $5::JSONB, $6)`,
          [seller.user_id,
           approved ? 'product_approved' : 'product_rejected',
           approved ? `Produto aprovado: ${seller.title}` : `Necessario ajustar: ${seller.title}`,
           approved
             ? `Parabens! Seu produto "${seller.title}" foi aprovado (confidence ${(b.confidence_score*100).toFixed(1)}%). Ja esta na vitrine.`
             : `Seu produto "${seller.title}" nao passou no QA.\nMotivos:\n- ${(b.reasons||[]).join('\n- ')}`,
           JSON.stringify({
             name: seller.full_name, score: (b.confidence_score*100).toFixed(1),
             reasons: (b.reasons || []).join('\n- '), title: seller.title,
           }),
           approved ? 0 : 1]
        );
      }

      // 5. Audit
      await c.query(
        `INSERT INTO audit_log (action, target_type, target_id, severity, payload_after)
         VALUES ($1, 'product', $2, $3, $4::JSONB)`,
        [`qa.${verdict}`, product_id, approved ? 'info' : 'warn',
         JSON.stringify({ confidence: b.confidence_score, reasons: b.reasons, provider: b.llm_provider })]
      );
    });

    log.info({ run_id: b.run_id, verdict, confidence: b.confidence_score }, '[qa.callback]');
    res.json({ ok: true, verdict });
  })
);

// GET /qa/runs/:product_id - historico de QA runs
// FIX-WORKER-12 pass 2 (DLP): antes era public -> qualquer um podia listar
// confidence_score, raw_response (codigo do produto!), tokens/cost LLM, reasons,
// llm_provider/model. Agora exige role admin/staff OU ser o seller dono do produto.
// Tambem valida UUID antes do query (evita PG 22P02 -> 404 generico).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
app.get('/qa/runs/:product_id', jwt.requireAuth(), asyncHandler(async (req, res, next) => {
  if (!UUID_RE.test(req.params.product_id)) {
    return next(errorHandler.badRequest('invalid_uuid'));
  }
  // Authz: admin/staff OU seller dono do produto
  const role = req.user?.role;
  if (role !== 'admin' && role !== 'staff') {
    const own = await query(
      `SELECT 1 FROM products p JOIN sellers s ON s.id = p.seller_id
        WHERE p.id = $1 AND s.user_id = $2::UUID`,
      [req.params.product_id, req.user.sub]
    );
    if (!own.rows.length) return next(errorHandler.forbidden('not_product_owner'));
  }
  const r = await query(
    `SELECT id, product_id, product_version_id, verdict, confidence_score,
            sintaxe_ok, resolves_problem, is_functional, reasons, suggestions,
            llm_provider, llm_model, tokens_input, tokens_output, cost_usd_cents,
            duration_ms, started_at, finished_at
       FROM product_qa_runs WHERE product_id = $1 ORDER BY started_at DESC LIMIT 50`,
    [req.params.product_id]
  );
  res.json({ runs: r.rows });
}));

app.use((req, res) => res.status(404).json({ error: 'route_not_found' }));
app.use(errorHandler.errorMiddleware);

const server = app.listen(PORT, () => log.info({ port: PORT, threshold: QA_THRESHOLD }, '[qa-svc] listening'));
['SIGINT','SIGTERM'].forEach((s) => process.on(s, () => server.close(() => process.exit(0))));
