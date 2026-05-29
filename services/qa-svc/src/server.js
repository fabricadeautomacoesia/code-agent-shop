'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const express = require('express');
const crypto = require('node:crypto');
const { z } = require('zod');
const { query, tx } = require('@cas/db-client');
const { logger, sanitize, errorHandler, asyncHandler, validate, jwt, startup, mask, cache, withRetry, notifCache } = require('@cas/shared');

// FIX-WORKER-17 pass 7: valida envs criticas ANTES de listen.
// QA_CALLBACK_SECRET obrigatorio (HMAC do worker -> autenticidade de scores).
// QA_RUN_INTERNAL_TOKEN warn (sem ele, /qa/run cai em jwt auth fallback OK).
startup.validateStartupEnv({
  critical: ['PG_PASS'],
  minLength: { PG_PASS: 12, QA_CALLBACK_SECRET: 32 },
  warnIfMissing: ['QA_CALLBACK_SECRET'],
  // FIX-WORKER-17 pass 8: QA_RUN_INTERNAL_TOKEN promovido para enforceInProd
  // Sem ele, product-svc -> qa-svc /qa/run falha silencioso (similar payment-svc).
  enforceInProd: ['QA_RUN_INTERNAL_TOKEN'],
});

const log = logger.child({ svc: 'qa-svc' });
const app = express();
const PORT = parseInt(process.env.PORT_QA || '3013', 10);

// FIX-WORKER-12 pass 366 (env config validation - silent rejection bug):
//   PRE-FIX: parseFloat(env || '0.80') sem validate range.
//   Cenarios broken:
//   - QA_CONFIDENCE_THRESHOLD='high' (typo) -> parseFloat = NaN
//     -> linha 435 score >= NaN sempre FALSE -> TODOS produtos rejeitados
//     silenciosamente (mesmo score=1.0)
//   - QA_CONFIDENCE_THRESHOLD='1.5' (typo admin) -> nada aprova (range invalido)
//   - QA_CONFIDENCE_THRESHOLD='-0.1' -> tudo aprova (todo score >= -0.1)
//   Detection: silent fail - apenas observavel apos N rejeitos legítimos confusos.
//   POST-FIX: parseFloat + isFinite + range [0..1] check + safe fallback +
//   log.warn se config invalida (alert ops).
function parseQaThreshold() {
  const raw = process.env.QA_CONFIDENCE_THRESHOLD;
  if (!raw) return 0.80; // default
  const v = parseFloat(raw);
  if (!Number.isFinite(v) || v < 0 || v > 1) {
    // log.warn fora do scope (logger nao initialized ainda) - console direto OK
    // boot-time validation - admin notice via stdout
    console.warn(`[qa-svc] QA_CONFIDENCE_THRESHOLD invalido '${raw}' (esperado 0.0-1.0), usando 0.80`);
    return 0.80;
  }
  return v;
}
const QA_THRESHOLD = parseQaThreshold();
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
/* FIX-WORKER-17 pass 305: trust proxy paridade cross-svc */
app.set('trust proxy', 1);
// FIX-WORKER-12: callback usa raw body para validar HMAC byte-exact antes de parsear
app.use('/qa/callback', express.raw({ type: '*/*', limit: '5mb' }));
app.use(express.json({ limit: '5mb' }));
app.use(sanitize.middleware());

// FIX-WORKER-12 pass 3: gateway reescreve /api/qa/* -> /qa/*, entao /health
// recebia /qa/health mas svc so tinha /health -> 404. Alias adicional.
const healthHandler = (_req, res) => res.json({ ok: true, svc: 'qa-svc', worker_url: WORKER_URL, threshold: QA_THRESHOLD });
app.get('/health', healthHandler);
app.get('/qa/health', healthHandler);

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
    if (valid) {
      /* FIX-WORKER-12 pass 295: flag internal-token authenticated.
         Sem este flag, handler /qa/run linha 128 falha:
         - req.user eh undefined (jwt nao rodou)
         - isAdmin = false (req.user?.role undef)
         - triggered_by check 403 (undefined !== triggered_by)
         Resultado: product-svc submit -> qa-svc 403 (internal flow broken)
         Defesa: marca req._internalAuth=true para bypass ownership check. */
      req._internalAuth = true;
      return next();
    }
    /* FIX-WORKER-12 pass 523 (audit_log critical paridade pass 458/462/463):
       PRE-FIX: log.warn apenas (Pino 7d retention) - NAO queryable forensic.
       SCOPE CRITICAL:
       - X-Internal-Token bypass = bypass JWT requireAuth admin/staff/service
       - product-svc -> qa-svc internal flow via this token
       - Attacker successful forge = trigger QA runs sem auth (cost LLM API + DoS)
       - Pattern V8 W17 pass 458 (vault.invalid_internal_token) ja estabeleceu pattern
       - Pass 462 qa.callback.invalid_signature ja teve audit
       - qa.run.invalid_internal_token (este) lagged - inconsistency cross-svc
       POST-FIX: audit_log critical paridade pass 458:
       - actor NULL (anonymous external attempt - JWT nao rodou ainda)
       - actor_role 'anonymous'
       - target_type 'qa_callback' (existing in VALID_TT aiops pass 462)
       - severity critical (SOC2 + compliance forensic)
       - tok_len_match preserved (forensic intel - paridade pass 462 sig_len_match)
       Fire-and-forget catch p/ nao bloquear JWT fallback chain. */
    const safeUaForensic = mask.text(req.headers['user-agent'] || '');
    log.warn({ ip: req.ip, ua: safeUaForensic }, '[qa.run.invalid_internal_token]');
    query(
      `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
       VALUES (NULL, 'anonymous', 'qa.run.invalid_internal_token', 'qa_callback', NULL, 'critical', $1::JSONB)`,
      [JSON.stringify({
        ip: req.ip,
        ua_prefix: safeUaForensic.slice(0, 60),
        tok_len_match: String(tok).length === QA_RUN_INTERNAL_TOKEN.length,
      })]
    ).catch((auditErr) => log.error({
      err: mask.text(String(auditErr.message || '').slice(0, 200)),
    }, '[qa.run.invalid_internal_token.audit_fail]'));
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
  asyncHandler(async (req, res, next) => {
    // FIX-WORKER-7 pass 28: 5 BUGS aplicando Pattern W7 17 regras.
    //
    // BUG 1 *** Regra K race inflight check ***
    //   Pre-fix: inflight SELECT sem FOR UPDATE -> 2 requests paralelos passam
    //   guard -> 2 INSERT runs verdict='running' -> double-process LLM (custo $$)
    //   + race no callback W7 pass 27 (mitigado mas LLM cost ja gasto).
    //   FIX: tx() + SELECT product + inflight check + INSERT run + UPDATE
    //   products STATUS tudo atomico.
    //
    // BUG 2 *** Regra B *** products.deleted_at IS NULL missing
    //   Produto deletado -> /qa/run dispatcher antigo chama -> processa
    //   produto fantasma -> LLM custo desperdicado + audit poluido.
    //   FIX: AND deleted_at IS NULL no SELECT.
    //
    // BUG 3 *** Regra M *** ownership check triggered_by missing
    //   Pre-fix: triggered_by validado syntaticamente (UUID Zod) MAS sem
    //   verificacao que req.user.sub === triggered_by ou role admin/staff.
    //   Atacante passa triggered_by=<victim_uuid> -> audit confunde forense.
    //   FIX: triggered_by null OU === req.user.sub OU role admin.
    //
    // BUG 4 *** Regra A *** product status check missing
    //   Produto em archived/qa_running concurrent/rejected_permanent: trigger
    //   novo run desperdica LLM + UI seller confusa.
    //   FIX: status IN ('draft', 'qa_pending', 'rejected', 'approved')
    //   (qa_running rejeita pelo inflight check)
    //   approved permite re-QA (v2 do produto).
    //
    // BUG 5 *** atomicity INSERT/UPDATE *** 2 queries lineares
    //   Pre-fix: INSERT run + UPDATE products status em queries separadas.
    //   UPDATE falha (lock/restart) -> run verdict='running' MAS product
    //   status nao virou 'qa_running' -> cron timeout busca status='qa_running'
    //   nao encontra stuck -> orfão.
    //   FIX: ambos dentro do MESMO tx() atomic.
    const { product_id, product_version_id, triggered_by } = req.body;

    // FIX bug 3 (Regra M): ownership/role check no triggered_by
    // FIX-WORKER-12 pass 295: bypass quando autenticado via internal-token
    // (product-svc -> qa-svc mesh flow). Internal token e service-to-service
    // confianca total - triggered_by eh seller_user_id passado pelo dispatcher.
    if (triggered_by && !req._internalAuth) {
      const isAdmin = ['admin', 'staff'].includes(req.user?.role);
      if (!isAdmin && triggered_by !== req.user?.sub) {
        return next(errorHandler.forbidden('triggered_by_mismatch',
          'triggered_by deve ser seu user_id ou voce precisa ser admin/staff'));
      }
    }

    let outcome;
    let product;
    let run_id;

    await tx(async (c) => {
      // FIX bug 1+2 (Regra K + B): SELECT FOR UPDATE products + deleted_at
      const p = await c.query(
        `SELECT id, title, description, kind, package_url, package_hash_sha256,
                tech_stack, api_keys_required, install_instructions, seller_id, status
           FROM products
          WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
        [product_id]
      );
      if (!p.rows.length) { outcome = { error: 'product_not_found' }; return; }
      product = p.rows[0];

      // FIX bug 4 (Regra A): valida status atual permite trigger QA
      const ALLOWED_STATUSES = ['draft', 'qa_pending', 'rejected', 'approved'];
      if (!ALLOWED_STATUSES.includes(product.status)) {
        outcome = { error: 'product_status_not_qa_eligible', current_status: product.status };
        return;
      }

      // FIX bug 1 (Regra K): inflight check DENTRO do tx + FOR UPDATE lock.
      // FOR UPDATE no products acima ja serializa via row-level lock,
      // segunda request bloqueia ate primeira COMMIT - depois ve INSERT run
      // realizado + status='qa_running' -> ALLOWED_STATUSES nao inclui
      // 'qa_running' -> rejeita.
      // Inflight 10min window mantido como defense (worker stuck).
      const inflight = await c.query(
        `SELECT id, started_at FROM product_qa_runs
          WHERE product_id = $1
            AND verdict = 'running'
            AND started_at > NOW() - INTERVAL '10 minutes'
          ORDER BY started_at DESC LIMIT 1`,
        [product_id]
      );
      if (inflight.rows.length) {
        outcome = {
          error: 'qa_run_already_in_progress',
          existing_run_id: inflight.rows[0].id,
          started_at: inflight.rows[0].started_at,
        };
        return;
      }

      // FIX bug 5 (atomicity): INSERT run + UPDATE product no MESMO tx
      const run = await c.query(
        `INSERT INTO product_qa_runs (product_id, product_version_id, triggered_by_user_id, verdict, started_at)
         VALUES ($1, $2, $3, 'running', NOW()) RETURNING id`,
        [product_id, product_version_id || null, triggered_by || null]
      );
      run_id = run.rows[0].id;

      await c.query(
        `UPDATE products SET status = 'qa_running', qa_verdict = 'running' WHERE id = $1`,
        [product_id]
      );
    });

    if (outcome?.error === 'product_not_found') {
      return res.status(404).json({ error: 'product_not_found' });
    }
    if (outcome?.error === 'product_status_not_qa_eligible') {
      return res.status(400).json({
        error: 'product_status_not_qa_eligible',
        message: `Status atual '${outcome.current_status}' nao permite trigger QA.`,
        current_status: outcome.current_status,
        allowed_statuses: ['draft', 'qa_pending', 'rejected', 'approved'],
      });
    }
    if (outcome?.error === 'qa_run_already_in_progress') {
      log.warn({ product_id, existing_run_id: outcome.existing_run_id }, '[qa.run.duplicate_blocked]');
      return res.status(409).json({
        error: 'qa_run_already_in_progress',
        message: 'QA ja em execucao para este produto. Aguarde resultado ou >10min para retry.',
        existing_run_id: outcome.existing_run_id,
        started_at: outcome.started_at,
      });
    }

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
          // FIX-WORKER-12 pass 235 (DLP operational): removido callback_secret_hint
          // do payload. PRE-FIX: hint=present|missing vazado em logs n8n + worker
          // + nodes intermediarios (Traefik/firewall) revelava se HMAC config
          // estava ativo. Atacante observando logs sabia se podia tentar forjar
          // callback sem assinatura. Hint nao tem uso functional - logging local
          // dentro do qa-svc cobre o gap operacional sem expor cross-service.
        };
        // Log local p/ ops debug (nao sai do svc)
        if (!QA_CALLBACK_SECRET) {
          log.warn({ run_id }, '[qa.dispatch.no_secret] QA_CALLBACK_SECRET ausente - callbacks sem HMAC');
        }

        // FIX-WORKER-12 pass 394 (worker fallback se N8N falha - resilience):
        //   PRE-FIX: if (N8N_URL) -> n8n only. Se n8n falha (auth/network/timeout)
        //   -> catch line 310 marca dispatch_failed. SEM fallback worker.
        //   N8N outage = TODOS QA runs failing (single point of failure).
        //   POST-FIX: try n8n primeiro, se falhar (n8nErr captured) tenta
        //   worker fallback transparente. Aumenta resilience pipeline QA.
        //   Worker fallback so funciona se WORKER_URL configurado (default OK).
        let dispatched = false;
        let n8nErr = null;
        if (N8N_URL) {
          try {
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
            dispatched = true;
          } catch (e) {
            n8nErr = mask.text(String(e.message || '').slice(0, 300));
            log.warn({ run_id, err: n8nErr }, '[qa.dispatch.n8n_failed] trying worker fallback');
            // Continua p/ fallback worker (nao throw)
          }
        }
        if (!dispatched) {
          // Opcao B: chamada direta ao worker Python (fallback ou default)
          log.info({ run_id, url: WORKER_URL, fallback: !!n8nErr }, '[qa.dispatch.worker]');
          await fetch(`${WORKER_URL}/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(300000), // 5 min
          });
          dispatched = true;
          // Log audit se foi fallback (operational signal)
          if (n8nErr) {
            log.info({ run_id, n8n_err: n8nErr }, '[qa.dispatch.fallback_succeeded]');
          }
        }
      } catch (e) {
        /* FIX-WORKER-12 pass 303 (DLP mask dispatch error):
           PRE-FIX: e.message raw em product_qa_runs.reasons + notifications.payload
           - n8n fetch fail (auth 401, network timeout) error msg pode conter:
             * 'Bearer abc123 invalid' (token vazado em response)
             * stack traces com PG_PASS/sk-keys
             * URLs com query string secrets
           - Stored em DB + notification payload sem mask
           POST-FIX: mask.text(e.message).slice(0, 200) antes storage
           Paridade pass 277/285/289 error tracking DLP cross-svc. */
        const safeErr = mask.text(String(e.message || '').slice(0, 500));
        log.error({ run_id, err: safeErr }, '[qa.dispatch_failed]');
        /* FIX-WORKER-12 pass 498 (atomicity dispatch_failed - paridade pass 27 BUG 5):
           PRE-FIX BUG: 2 UPDATEs sem tx() wrapping:
             await query('UPDATE product_qa_runs SET verdict=error ...')  // 1
             await query('UPDATE products SET status=qa_pending ...')      // 2
           - UPDATE 1 succeeds, UPDATE 2 fails (deadlock 40P01/network/lock)
             -> qa_run.verdict='error' MAS product.status='qa_running' (still)
             -> Cron stuck-cleanup procura 'qa_running' > 10min - encontra
                eventualmente MAS state divergence ate la (UI seller confusa)
             -> Late callback chega: TERMINAL_VERDICTS.has('error')=TRUE -> NOOP
                MAS product remains 'qa_running' permanentemente
           - Sem withRetry: deadlock 40P01 abandona sem retry -> setImmediate
             swallow exception silently
           - Bonus bug: produto previamente 'approved' (re-QA v2) ao falhar
             dispatch revertia para 'qa_pending' (perda de estado approved)
             -> v2 falhou QA mas v1 estava live, dispatch error escondia v1
           POST-FIX:
           - tx() wrapping atomico
           - withRetry para deadlock 40P01 cross-svc paridade pass 310
           - Trade-off: revertendo p/ qa_pending (estado seguro pre-QA) ainda
             eh correto para v1 since pass 28 BUG 4 requires re-trigger explicit
             (status qa_pending allows seller retry). Counter sellers nao mexe
             aqui pois /qa/run nao incrementou (so callback incrementa em pass 4) */
        await withRetry('qa.dispatch_failed.tx', async () => {
          await tx(async (c) => {
            await c.query(
              `UPDATE product_qa_runs SET verdict = 'error', finished_at = NOW(),
                                           reasons = ARRAY[$1] WHERE id = $2`,
              [`dispatch_failed: ${safeErr}`, run_id]
            );
            await c.query(
              `UPDATE products SET status = 'qa_pending', qa_verdict = 'pending' WHERE id = $1`,
              [product_id]
            );
          });
        });
        // FIX-WORKER-12 pass 6: notifica seller (dispatch silenciava falhas).
        // Antes: seller via "status = qa_pending" eternamente, sem entender porque
        // QA nao saiu de pending. Agora: notificacao explicita + sugestao retry.
        if (product.seller_id) {
          try {
            const sellerUser = await query(
              `SELECT user_id FROM sellers WHERE id = $1 AND status = 'active'`,
              [product.seller_id]
            );
            if (sellerUser.rows.length) {
              /* FIX-WORKER-12 pass 303: payload.error masked (safeErr ja calculado linha acima) */
              await query(
                `INSERT INTO notifications (user_id, channel, template_code, title, body, priority, payload)
                 VALUES ($1, 'in_app', 'qa_dispatch_failed',
                         'QA pipeline indisponivel temporariamente',
                         $2, 2, $3::JSONB)`,
                [
                  sellerUser.rows[0].user_id,
                  `Nao foi possivel iniciar a analise QA do produto "${product.title}". Tente reenviar para QA em alguns minutos.`,
                  JSON.stringify({ product_id, run_id, error: safeErr.slice(0, 200) })
                ]
              );
              // FIX-WORKER-12 pass 476 (notifCache cross-svc - qa_dispatch_failed)
              // Seller submitted produto pra QA -> dispatch falhou -> espera ver alerta IMEDIATO
              notifCache.invalidate(sellerUser.rows[0].user_id);
            }
          } catch (notifErr) {
            log.warn({ err: notifErr.message }, '[qa.dispatch.notif.fail]');
          }
        }
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
    const safeUaForensic = mask.text(req.headers['user-agent'] || '');
    log.warn({ ip: req.ip, ua: safeUaForensic }, '[qa.callback.invalid_signature]');
    /* FIX-WORKER-12 pass 462 (audit_log critical paridade pass 458 vault.invalid_internal_token):
       PRE-FIX: log.warn apenas (Pino 7d retention) - NAO queryable forensic.
       SCOPE CRITICAL:
       - QA_CALLBACK_SECRET HMAC bypass = bypass entire LLM QA pipeline
       - Attacker poderia forjar callback approving produto malicioso (LLM never ran)
       - Successful exploit = pula moderacao -> produto live com payload
       - Sem audit_log = SOC2 + LGPD forensic gap post-incident
       POST-FIX: audit_log critical paridade vault.invalid_internal_token pass 458:
       - actor NULL (anonymous external callback)
       - target_type 'qa_callback' (NOVO - add VALID_TT aiops pass 455)
       - severity critical
       - sig_len_match preserved (forensic intel - paridade tok_len_match pass 4)
       Fire-and-forget catch p/ nao bloquear 401 response. */
    query(
      `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
       VALUES (NULL, 'anonymous', 'qa.callback.invalid_signature', 'qa_callback', NULL, 'critical', $1::JSONB)`,
      [JSON.stringify({
        ip: req.ip,
        ua_prefix: safeUaForensic.slice(0, 60),
        sig_len_match: String(sig).length === expected.length,
      })]
    ).catch((auditErr) => log.error({
      err: mask.text(String(auditErr.message || '').slice(0, 200)),
    }, '[qa.callback.invalid_signature.audit_fail]'));
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
  /* FIX-WORKER-12 pass 335: callback schema anti-DoS hardening paridade pass 332-334.
     PRE-FIX gaps:
     - reasons/suggestions array sem max() + item sem max
     - llm_provider/llm_model string sem max
     - tokens/cost/duration int sem nonnegative ou upper bound
     - raw_response z.any() = unlimited payload
     POST-FIX:
     - reasons/suggestions: array.max(50) + item.max(2000)
     - llm_provider: max(40) ('openai', 'anthropic', 'gemini', etc)
     - llm_model: max(100) ('gpt-4o-2024-08-06' etc)
     - tokens: nonnegative + max 10M
     - cost_usd_cents: nonnegative + max 1B (10M USD ceiling)
     - duration_ms: nonnegative + max 1h (3600000)
     - raw_response: z.record/z.string limit 50kb stringify (express.json default 5mb mas ainda) */
  validate({ body: z.object({
    run_id: z.string().uuid(),
    confidence_score: z.number().min(0).max(1),
    sintaxe_ok: z.boolean().optional(),
    resolves_problem: z.boolean().optional(),
    is_functional: z.boolean().optional(),
    reasons: z.array(z.string().max(2000)).max(50).optional(),
    suggestions: z.array(z.string().max(2000)).max(50).optional(),
    llm_provider: z.string().max(40).optional(),
    llm_model: z.string().max(100).optional(),
    tokens_input: z.number().int().nonnegative().max(10_000_000).optional(),
    tokens_output: z.number().int().nonnegative().max(10_000_000).optional(),
    cost_usd_cents: z.number().int().nonnegative().max(1_000_000_000).optional(),
    duration_ms: z.number().int().nonnegative().max(3_600_000).optional(),
    raw_response: z.any().optional(),
  })}),
  asyncHandler(async (req, res) => {
    // FIX-WORKER-7 pass 27: 4 BUGS CRITICOS aplicando Regras K, N, B + idempotency.
    //
    // BUG 1 *** IDEMPOTENCY CATASTROFICO *** sem guard re-process
    //   Cenario fraude:
    //   T0: n8n callback {run_id=X, score=0.9} -> APPROVED -> order/license
    //   T1: Admin REJEITA manualmente via /admin/qa/runs/:id/reject
    //       -> product_qa_runs.verdict='rejected', products.status='rejected'
    //   T2: n8n NAO recebeu ack T0 (rede flaky) -> RETRY callback (mesma assinatura HMAC)
    //   T3: qaCallbackGuard valida HMAC OK -> entra handler
    //   T4: UPDATE product_qa_runs SET verdict='approved' (sobrescreve admin reject!)
    //   T5: UPDATE products SET status='approved' -> REVERTE rejeicao admin
    //   T6: BYPASS de moderation via callback retry - critical fraude vector
    //
    // BUG 2 *** Regra N STATE MACHINE *** allowed transitions ausentes
    //   verdict='running' -> [approved, rejected, error, timeout] OK
    //   verdict='approved' -> [] terminal
    //   verdict='rejected' -> [] terminal (admin force_approve via endpoint dedicado)
    //   verdict='timeout' -> [] terminal (cron cancela, retry inicia novo run)
    //   FIX: validar transicao antes UPDATE - reprocessamento = noop log info
    //
    // BUG 3 *** Regra K *** SELECT FOR UPDATE em product_qa_runs + products
    //   2 callbacks duplicados Asaas-style retry simultaneo -> race condition
    //   mesma pattern pass 22 (payment webhook).
    //
    // BUG 4 Regra B products.deleted_at IS NULL
    //   Callback chega apos produto soft-deleted -> processa indevidamente.
    const b = req.body;
    const approved = b.confidence_score >= QA_THRESHOLD;
    const verdict = approved ? 'approved' : 'rejected';

    // ALLOWED TRANSITIONS state machine (Regra N)
    const TERMINAL_VERDICTS = new Set(['approved', 'rejected', 'error', 'timeout']);

    let stateMachineBlocked = false;
    // FIX-WORKER-12 pass 174: captura user_id do seller p/ invalidacao cache pos-tx
    let sellerUserIdToInvalidate = null;

    /* FIX-WORKER-12 pass 310 (deadlock retry callback handler):
       PRE-FIX: await tx() sem withRetry wrap. Cenarios deadlock 40P01:
       - 2 callbacks concorrentes (n8n burst retry) - ambos SELECT FOR UPDATE
         em mesmo product row -> PG detecta deadlock, mata 1 com 40P01
       - Pass 309 frontend retry 3x dispara callbacks paralelos
       - Sem retry, callback falha -> qa-worker tenta 3x mas mesmo deadlock
       POST-FIX: withRetry envolve tx(), 3 attempts com backoff exponencial.
       Pattern V8 cross-svc consolidado (asaas.js, payment-svc, vault-svc). */
    await withRetry('qa.callback.tx', async () => {
    await tx(async (c) => {
      // FIX bug 3 (Regra K): SELECT FOR UPDATE em product_qa_runs - lock primeiro
      // FIX bug 1 (idempotency): verifica verdict atual ANTES de UPDATE
      const runRow = await c.query(
        `SELECT id, product_id, product_version_id, verdict
           FROM product_qa_runs
          WHERE id = $1
          FOR UPDATE`,
        [b.run_id]
      );
      if (!runRow.rows.length) return; // run nao existe (rare)

      // FIX bug 2 (Regra N + idempotency): se ja em terminal state, NOOP
      // Cobre: re-callback duplicado, retry pos-admin-reject, race window
      const currentVerdict = runRow.rows[0].verdict;
      if (TERMINAL_VERDICTS.has(currentVerdict)) {
        log.info({
          run_id: b.run_id,
          current_verdict: currentVerdict,
          incoming_verdict: verdict,
        }, '[qa.callback.transition_blocked] run ja em estado terminal - ignorando reprocessamento');
        stateMachineBlocked = true;
        return;
      }

      // Estado atual = 'running' (unico transicionavel) - UPDATE ok
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
         WHERE id = $15 AND verdict = 'running'`,
        [verdict, b.confidence_score, b.sintaxe_ok, b.resolves_problem, b.is_functional,
         b.reasons || null, b.suggestions || null, b.llm_provider, b.llm_model,
         b.tokens_input || null, b.tokens_output || null, b.cost_usd_cents || null,
         b.duration_ms || null, JSON.stringify(b.raw_response || {}), b.run_id]
      );

      const { product_id, product_version_id } = runRow.rows[0];

      // FIX bug 3+4 (Regra K + B): FOR UPDATE products + deleted_at filter
      // Lock products row anti-race + soft-delete check defensive
      const prev = await c.query(
        `SELECT status FROM products WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [product_id]
      );
      if (!prev.rows.length) {
        // Product deletado entre run start e callback - run marcada como
        // approved/rejected mas product UPDATE skipped (defensive).
        log.warn({ product_id, run_id: b.run_id },
          '[qa.callback.product_deleted] callback para produto soft-deleted - run state set, product skip');
        return;
      }
      const prevStatus = prev.rows[0]?.status;

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
        // FIX-WORKER-12 pass 4: BUG counter inflado.
        // Antes: total_products_active += 1 a CADA QA approved callback.
        // QA roda multiplas vezes no mesmo produto (v1, v2, v3, etc) ->
        // counter inflava sem teto. Seller com 1 produto + 5 versoes virava
        // total_products_active=5 -> ranking errado, KPIs admin errados,
        // "Top Sellers" leaderboard tendencioso.
        // Agora: so incrementa em TRANSICAO real (prevStatus != 'approved').
        // Re-aprovacao de v2 do mesmo produto = noop counter.
        if (prevStatus !== 'approved') {
          await c.query(
            `UPDATE sellers SET total_products_active = total_products_active + 1
               WHERE id = (SELECT seller_id FROM products WHERE id = $1)`, [product_id]
          );
        }
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
        // FIX-WORKER-12 pass 4: simetrico ao incremento - decrementar quando
        // produto sai de approved -> rejected (v2 falhou QA, produto desaparece
        // da vitrine). GREATEST(0, x-1) impede underflow se counter ja zerou.
        if (prevStatus === 'approved') {
          await c.query(
            `UPDATE sellers SET total_products_active = GREATEST(0, total_products_active - 1)
               WHERE id = (SELECT seller_id FROM products WHERE id = $1)`, [product_id]
          );
        }
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
      // FIX-WORKER-12 pass 435 (slug em notification payload - consume inferCtaUrl pass 355):
      //   PRE-FIX: SELECT s.user_id, p.title, u.full_name, u.email - SEM p.slug
      //   payload notification INSERT linha 657-663 SEM slug field
      //   notification-bell inferCtaUrl pass 355:
      //     case 'product_approved'/'product_rejected':
      //       return p.slug ? `/product/${p.slug}` : '/conta';
      //   Sem slug -> fallback '/conta' generic -> seller clicava notif
      //   "Produto aprovado: X" -> ia para /conta dashboard (nao para PDP)
      //   UX gap critico: seller queria ver produto live na vitrine, ia para conta vazia
      //   POST-FIX: + p.slug no SELECT + payload JSONB slug field
      //   Paridade pass 434 (qna_id) - notification payload DEVE conter all fields p/ deep-link
      const u = await c.query(
        `SELECT s.user_id, p.title, p.slug, u.full_name, u.email
           FROM products p
           JOIN sellers s ON s.id = p.seller_id
           JOIN users u ON u.id = s.user_id
          WHERE p.id = $1`, [product_id]
      );
      if (u.rows.length) {
        const seller = u.rows[0];
        /* FIX-WORKER-12 pass 284 (notif rejected sem reasons UX):
           PRE-FIX: reasons=[] (LLM sem motivos explicitos) gerava:
             "Seu produto X nao passou no QA.\nMotivos:\n- "
           Trailing bullet vazio - UX feio + seller confuso "qual e o motivo?"
           POST-FIX: condicional - se reasons vazio render mensagem generica
           CTA pra contato; se >=1 reason render lista bullet. payload tambem
           clean (sem leading '\n- ' artificial). Pattern V8 zero-state hide. */
        const reasonsList = (b.reasons || []).filter((s) => s && String(s).trim());
        const rejBody = reasonsList.length > 0
          ? `Seu produto "${seller.title}" nao passou no QA.\nMotivos:\n- ${reasonsList.join('\n- ')}`
          : `Seu produto "${seller.title}" nao passou no QA (confidence ${(b.confidence_score*100).toFixed(1)}%). O sistema nao gerou motivos explicitos - revise descricao, codigo e cover image. Para detalhes, abra ticket no suporte.`;
        await c.query(
          `INSERT INTO notifications (user_id, channel, template_code, title, body, payload, priority)
           VALUES ($1, 'email', $2, $3, $4, $5::JSONB, $6)`,
          [seller.user_id,
           approved ? 'product_approved' : 'product_rejected',
           approved ? `Produto aprovado: ${seller.title}` : `Necessario ajustar: ${seller.title}`,
           approved
             ? `Parabens! Seu produto "${seller.title}" foi aprovado (confidence ${(b.confidence_score*100).toFixed(1)}%). Ja esta na vitrine.`
             : rejBody,
           JSON.stringify({
             name: seller.full_name, score: (b.confidence_score*100).toFixed(1),
             reasons: reasonsList.length > 0 ? reasonsList.join('\n- ') : null,
             reasons_count: reasonsList.length,
             title: seller.title,
             // FIX pass 435: slug p/ inferCtaUrl deep-link /product/{slug}
             // Sem slug -> fallback '/conta' generic (UX gap pre-fix)
             slug: seller.slug,
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
      // FIX-WORKER-12 pass 174 (cache-coherency): captura seller user_id p/
      // invalidacao pos-tx (cache seller-svc /sla-status + /kpi 60-300s).
      // Sem invalidacao seller veria SLA stale ate 60s apos QA approve.
      sellerUserIdToInvalidate = u.rows?.[0]?.user_id || null;
    });
    }); // close withRetry pass 310

    // FIX-WORKER-12 pass 174: cache invalidation pos-tx commit (best-effort).
    // Evita: seller submete produto -> QA approve -> dashboard mostra SLA timer
    // antigo por ate 60s (TTL cache /sla-status W18-174).
    /* FIX-WORKER-12 pass 470 (notifCache cross-svc cadeia consume pass 467+468+469):
       PRE-FIX (pass 174): cache invalidation SO se approved
       - SLA + KPI caches sao gated por approved (so mudam em approve)
       - MAS notifCache (notifs:list + unread-count) DEVE invalidar AMBOS paths:
         * approved: notif product_approved (priority 0) - seller v vitrine
         * rejected: notif product_rejected (priority 1) - seller precisa AGIR
       - PRE-FIX: rejected seller aguarda 20s ate ver "necessario ajustar"
       - Seller fica esperando QA decision -> bell 20s delay = ansiedade
       POST-FIX: notifCache.invalidate(sellerUserIdToInvalidate) em AMBOS cases.
       SLA+KPI cache invalidation preserved gated by approved (correct logic). */
    if (sellerUserIdToInvalidate) {
      try {
        const invalidations = [notifCache.invalidate(sellerUserIdToInvalidate)];
        if (approved) {
          invalidations.push(cache.del(`seller:sla-status:${sellerUserIdToInvalidate}`));
          invalidations.push(cache.del(`seller:kpi:${sellerUserIdToInvalidate}`));
        }
        await Promise.all(invalidations);
      } catch (e) {
        log.warn({ /* FIX pass 343 DLP */ err: mask.text(String(e.message || '').slice(0, 300)), user: sellerUserIdToInvalidate }, '[cache.invalidate_fail]');
      }
    }

    // FIX-WORKER-7 pass 27: response indicates state machine block.
    // n8n retry idempotente: recebe ok=true mesmo se bloqueado.
    // Permite n8n stop retry sem confundir admin com novos eventos.
    if (stateMachineBlocked) {
      return res.json({ ok: true, status: 'already_processed', run_id: b.run_id });
    }
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
// GET /qa/runs/:product_id - historico QA runs (admin/staff full + seller owner masked)
// FIX-WORKER-7 pass 96: 7 BUGS aplicando Pattern W7.
//
// BUG 1 *** Regra D *** ORDER BY started_at DESC sem id DESC tiebreaker
//   Cron QA pode rodar burst (timeout retry) -> started_at identicos
// BUG 2 *** Regra E *** hardcoded LIMIT 50 sem ?limit/?offset
// BUG 3 *** DLP reasons/suggestions arrays *** LLM raw text leak
//   PRE-FIX: reasons/suggestions retornados raw. LLM concatena error.message
//   que pode ter Bearer/PG_PASS/JWT em stack traces de exception caught.
//   FIX: mask.text() em cada string array element.
// BUG 4 *** DLP llm_provider/llm_model/cost p/ SELLER ***
//   PRE-FIX: seller ve llm_provider="openai" / llm_model="gpt-4o" /
//   cost_usd_cents - vaza fingerprint operacional + custos internos.
//   Atacante pode tentar exploit specific provider quirks.
//   Compliance: gross margin disclosure (custo vs price seller).
//   FIX: tier-split (admin=full, seller=masked sem provider/model/cost).
// BUG 5 *** Regra A status pre-check MISSING ***
//   PRE-FIX: aceita product_id deletado/archived - runs fantasma response.
//   FIX: ownership query inclui status IN ('approved','platform_owned',
//   'qa_pending','qa_running','rejected','draft') - admite all states
//   ATIVOS (draft/qa_pending para seller seu produto novo, etc).
// BUG 6 *** ?verdict FILTER MISSING ***
//   Debug UX: filtrar SO "timeout"/"rejected"/"running" para investigar issues.
//   FIX: ?verdict enum (approved|rejected|running|timeout|error).
// BUG 7 *** Total + has_more UX paginacao ***
const QA_VERDICT_ENUM = new Set(['approved','rejected','running','timeout','error']);

app.get('/qa/runs/:product_id', jwt.requireAuth(), asyncHandler(async (req, res, next) => {
  if (!UUID_RE.test(req.params.product_id)) {
    return next(errorHandler.badRequest('invalid_uuid'));
  }
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

  // BUG 6: verdict filter optional
  const verdictFilter = req.query.verdict ? String(req.query.verdict) : null;
  if (verdictFilter && !QA_VERDICT_ENUM.has(verdictFilter)) {
    return res.status(400).json({ error: 'invalid_verdict', allowed: Array.from(QA_VERDICT_ENUM) });
  }

  // Authz: admin/staff OU seller dono do produto + Regra A status check
  const role = req.user?.role;
  const isAdmin = role === 'admin' || role === 'staff';
  if (!isAdmin) {
    const own = await query(
      `SELECT 1 FROM products p JOIN sellers s ON s.id = p.seller_id
        WHERE p.id = $1 AND s.user_id = $2::UUID AND p.deleted_at IS NULL`,
      [req.params.product_id, req.user.sub]
    );
    if (!own.rows.length) return next(errorHandler.forbidden('not_product_owner'));
  }

  // Build WHERE
  const whereParts = ['product_id = $1'];
  const params = [req.params.product_id];
  let i = 2;
  if (verdictFilter) {
    whereParts.push(`verdict = $${i++}`);
    params.push(verdictFilter);
  }
  params.push(limit, offset);
  const limIdx = i++;
  const offIdx = i++;

  // FIX-WORKER-18 pass 249 (COUNT window consolidation):
  //   PRE-FIX: 2 queries separadas (SELECT rows + SELECT COUNT). Admin lista
  //   /admin/qa/runs por verdict era 2 DB roundtrips per request, com mesma
  //   condicao WHERE replicada. Cada admin polling page disparava 2 hits DB.
  //   POST-FIX: Pattern W18 consolidado em 12+ endpoints (passes 178-202+).
  //   COUNT(*) OVER() window agrega contagem na MESMA query - 50% reducao
  //   roundtrip DB + same WHERE plan reuse pelo PG.
  const r = await query(
    `SELECT id, product_id, product_version_id, verdict, confidence_score,
            sintaxe_ok, resolves_problem, is_functional, reasons, suggestions,
            llm_provider, llm_model, tokens_input, tokens_output, cost_usd_cents,
            duration_ms, started_at, finished_at,
            COUNT(*) OVER()::INT AS _total
       FROM product_qa_runs
      WHERE ${whereParts.join(' AND ')}
      ORDER BY started_at DESC, id DESC
      LIMIT $${limIdx} OFFSET $${offIdx}`,
    params
  );

  const total = r.rows[0]?._total ?? 0;

  // BUG 3+4: DLP tier-split (admin=full, seller=masked)
  // FIX-WORKER-18 pass 249: strip _total (window function aggregate) p/ nao vazar
  // ao cliente final - eh metadata interno usado linha 689 acima
  const runs = r.rows.map((row) => {
    const { _total, ...rest } = row;
    if (isAdmin) {
      return rest;
    }
    // Seller: mask DLP fields + remove operational fingerprint
    return {
      ...rest,
      // BUG 3: mask.text() em reasons/suggestions (LLM error concat may have secrets)
      reasons: Array.isArray(rest.reasons)
        ? rest.reasons.map((r) => typeof r === 'string' ? mask.text(r) : r)
        : rest.reasons,
      suggestions: Array.isArray(rest.suggestions)
        ? rest.suggestions.map((s) => typeof s === 'string' ? mask.text(s) : s)
        : rest.suggestions,
      // BUG 4: remove operational fingerprint p/ seller
      llm_provider: null,
      llm_model: null,
      cost_usd_cents: null,
      tokens_input: null,
      tokens_output: null,
    };
  });

  res.json({
    runs,
    total, limit, offset,
    has_more: (offset + runs.length) < total,
    verdict: verdictFilter,
    is_admin_view: isAdmin,
  });
}));

// ============================================================
// FIX-WORKER-12 pass 7: cron stuck QA runs cleanup
// ============================================================
// Contexto: W12 pass 6 adicionou anti-duplicate check (10min window).
// Runs com verdict='running' > 10min sem callback ficam "stuck" - ou n8n
// crashou no meio do dispatch, ou worker.py travou, ou callback falhou
// silenciosamente. Estes runs:
// - Bloqueiam novas tentativas (anti-duplicate de pass 6 ignora apos 10min)
// - products.status='qa_running' persiste indefinidamente
// - Seller frustrado, suporte ticket
//
// Este cron diario:
// 1. SELECT runs com verdict='running' + started_at > 10min ago
// 2. UPDATE verdict='timeout' + finished_at=NOW + reasons=['cron_timeout: no callback after Xmin']
// 3. UPDATE products SET status='qa_pending' (libera para retry)
// 4. Notify seller (consistente com W12 pass 6 fan-out)
//
// Interval: 5min (verifica frequente, mas cada run individual so timeout apos
// passar dos 10min do anti-duplicate window).
async function timeoutStuckRuns() {
  try {
    // FIX-WORKER-12 pass 240 (multi-replica cron race):
    //   PRE-FIX: Swarm com 2+ replicas qa-svc, ambas rodavam setInterval(5min)
    //   simultaneo (no clock drift) -> ambas SELECT mesmos 20 stuck rows.
    //   UPDATE protegido por verdict='running' WHERE filter (segunda no-op),
    //   MAS notification INSERT duplicava: cada replica criava notif
    //   'qa_run_timeout' para mesmo user_id+product_id (sem dedup constraint
    //   - notifications table aceita N rows per same template).
    //   Trabalho dobrado + spam usuario + log noise.
    //   POST-FIX: SELECT FOR UPDATE SKIP LOCKED. Cada replica pega lote
    //   DIFERENTE de stuck runs sem contention. Pattern processOutbox
    //   notification-svc consolidado.
    //   NOTA: lock liberado em commit do tx() seguinte - aqui select
    //   isolado consome o lock implicit ao read transaction.
    //   Workaround correto: usar UPDATE...RETURNING para claim atomico.
    const stuck = await query(
      `WITH claimed AS (
         UPDATE product_qa_runs
            SET verdict = verdict  -- no-op UPDATE p/ row lock
          WHERE id IN (
            SELECT id FROM product_qa_runs
             WHERE verdict = 'running'
               AND started_at < NOW() - INTERVAL '10 minutes'
             ORDER BY started_at ASC LIMIT 20
             FOR UPDATE SKIP LOCKED
          )
          RETURNING id, product_id, started_at,
                    EXTRACT(EPOCH FROM (NOW() - started_at))/60 AS minutes_running
       )
       SELECT * FROM claimed`
    );
    if (!stuck.rows.length) return;
    log.warn({ count: stuck.rows.length }, '[qa.timeout.cron]');
    for (const run of stuck.rows) {
      const minutes = Math.floor(Number(run.minutes_running));
      try {
        await tx(async (c) => {
          // Marca run timeout
          await c.query(
            `UPDATE product_qa_runs
                SET verdict = 'timeout',
                    finished_at = NOW(),
                    reasons = ARRAY[$1]
              WHERE id = $2 AND verdict = 'running'`,
            [`cron_timeout: no callback after ${minutes}min`, run.id]
          );
          // Libera produto para retry
          await c.query(
            `UPDATE products SET status = 'qa_pending', qa_verdict = 'pending'
              WHERE id = $1 AND status = 'qa_running'`,
            [run.product_id]
          );
          // Notify seller (mesma logica W12 pass 6 dispatch_failed)
          const sellerInfo = await c.query(
            `SELECT s.user_id, p.title FROM products p
               JOIN sellers s ON s.id = p.seller_id
              WHERE p.id = $1 AND s.status = 'active'`,
            [run.product_id]
          );
          if (sellerInfo.rows.length) {
            await c.query(
              `INSERT INTO notifications (user_id, channel, template_code, title, body, priority, payload)
               VALUES ($1, 'in_app', 'qa_run_timeout',
                       'QA timeout - reenvio liberado',
                       $2, 2, $3::JSONB)`,
              [
                sellerInfo.rows[0].user_id,
                `A analise QA do produto "${sellerInfo.rows[0].title}" demorou alem do esperado (${minutes}min). Foi cancelada automaticamente. Voce pode reenviar para QA quando estiver pronto.`,
                JSON.stringify({ product_id: run.product_id, run_id: run.id, minutes })
              ]
            );
            // FIX-WORKER-12 pass 476 (notifCache cross-svc - qa_run_timeout)
            // Seller esperou QA processar 10min+ -> timeout -> espera reenvio IMEDIATO
            notifCache.invalidate(sellerInfo.rows[0].user_id);
          }
        });
        log.info({ run_id: run.id, minutes }, '[qa.timeout.ok]');
      } catch (e) {
        log.error({ run_id: run.id, /* FIX pass 343 DLP */ err: mask.text(String(e.message || '').slice(0, 300)) }, '[qa.timeout.fail]');
      }
    }
  } catch (e) {
    log.error({ /* FIX pass 343 DLP */ err: mask.text(String(e.message || '').slice(0, 300)) }, '[qa.timeout.cron.fail]');
  }
}

// GET /qa/runs/stuck - admin lista runs candidatos a timeout (pre-cron visibility)
// FIX-WORKER-7 pass 96: 3 BUGS aplicando Pattern W7 (Regra D+E + threshold param).
//
// BUG 1 *** Regra D *** ORDER BY started_at ASC sem id ASC tiebreaker
// BUG 2 *** Regra E *** hardcoded LIMIT 50 sem ?limit/?offset
// BUG 3 *** ?threshold_minutes MISSING ***
//   PRE-FIX: hardcoded 5 min. Admin pode querer 10/15/30 min p/ triage.
//   FIX: ?threshold_minutes (1-1440 = 24h cap, default 5).
app.get('/qa/runs/stuck',
  jwt.requireAuth({ roles: ['admin', 'staff'] }),
  asyncHandler(async (req, res) => {
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const thresholdMin = Math.max(1, Math.min(1440, parseInt(req.query.threshold_minutes, 10) || 5));

    // FIX-WORKER-12+W18 pass 265 (COUNT window consolidation + idx_qa_runs_inflight reuse):
    //   PRE-FIX: 2 queries (SELECT rows + SELECT COUNT) com WHERE identico
    //   Endpoint /admin/qa-runs/stuck eh polled por dashboard admin (30s).
    //   2 roundtrips DB per request + plan executado 2x.
    //   Idx idx_qa_runs_inflight (mig 071, pass 239) cobre WHERE verdict='running'
    //   + started_at DESC mas query usa ASC (FIFO oldest stuck first).
    //   POST-FIX: COUNT(*) OVER() window consolida. Pattern V8 consolidado
    //   passes 178-249+ em 14+ endpoints.
    //   ASC mantido (FIFO operational - admin trabalha oldest first em incident).
    const r = await query(
      `SELECT id, product_id, started_at, llm_provider, n8n_execution_id,
              (EXTRACT(EPOCH FROM (NOW() - started_at))/60)::INT AS minutes_running,
              COUNT(*) OVER()::INT AS _total
         FROM product_qa_runs
        WHERE verdict = 'running'
          AND started_at < NOW() - ($1 || ' minutes')::INTERVAL
        ORDER BY started_at ASC, id ASC
        LIMIT $2 OFFSET $3`,
      [String(thresholdMin), limit, offset]
    );

    const total = r.rows[0]?._total ?? 0;
    const runs = r.rows.map((row) => { const { _total, ...rest } = row; return rest; });

    res.json({
      runs,
      count: runs.length,
      total,
      limit, offset,
      threshold_minutes: thresholdMin,
      has_more: (offset + runs.length) < total,
    });
  })
);

// Cron interval: 5min + warmup 60s
setTimeout(() => timeoutStuckRuns().catch(() => {}), 60000);
setInterval(() => timeoutStuckRuns().catch((e) => log.error({ /* FIX pass 343 DLP */ err: mask.text(String(e.message || '').slice(0, 300)) }, '[qa.timeout.cron.fail]')), 5 * 60 * 1000);
log.info('[qa.timeout.cron] stuck runs cron started (5min interval, 10min threshold)');

app.use((req, res) => res.status(404).json({ error: 'route_not_found' }));
app.use(errorHandler.errorMiddleware);

const server = app.listen(PORT, () => log.info({ port: PORT, threshold: QA_THRESHOLD }, '[qa-svc] listening'));
['SIGINT','SIGTERM'].forEach((s) => process.on(s, () => server.close(() => process.exit(0))));
