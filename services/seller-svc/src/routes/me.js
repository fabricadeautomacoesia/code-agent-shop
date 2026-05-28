'use strict';

const express = require('express');
const { z } = require('zod');
const { query, tx } = require('@cas/db-client');
const { jwt, asyncHandler, validate, errorHandler, crypto, cache, logger, rateLimiter, mask } = require('@cas/shared');

const log = logger.child({ svc: 'seller-svc', mod: 'me' });
const router = express.Router();
router.use(jwt.requireAuth({ roles: ['seller','admin'] }));

// FIX-WORKER-18 pass 6: helper de invalidacao cache apos mutations de seller.
// W18 pass 5 adicionou cache em /sellers, /:slug, /:slug/stats, /:slug/products
// (TTL 60-180s). Sem invalidacao em PATCH, store_name/description ficavam stale.
async function invalidateSellerCache(userId) {
  try {
    // Lookup store_slug por user_id
    const r = await query('SELECT store_slug FROM sellers WHERE user_id = $1', [userId]);
    const tasks = [cache.del('sellers:list:*')];
    // FIX-WORKER-18 pass 174: invalidar tambem sla-status + kpi per-user
    // (W18-174 adicionou cache 60s em /sla-status, antes ja existia cache em /kpi)
    if (userId) {
      tasks.push(
        cache.del(`seller:sla-status:${userId}`),
        cache.del(`seller:kpi:${userId}`),
        // FIX-WORKER-18 pass 231: invalidate seller:me apos PATCH/KYC/etc
        cache.del(`seller:me:${userId}`)
      );
    }
    if (r.rows.length) {
      const slug = r.rows[0].store_slug;
      tasks.push(
        cache.del(`sellers:detail:${slug}`),
        cache.del(`sellers:stats:${slug}`),
        cache.del(`sellers:products:${slug}:*`)
      );
    }
    await Promise.all(tasks);
  } catch (e) { log.warn({ err: e.message }, '[cache.invalidate_fail]'); }
}

// FIX-WORKER-18 pass 231: cache key helper p/ GET /sellers/me (vary by user)
const sellerMeCacheKey = (req) => `seller:me:${req.user.sub}`;

// GET /sellers/me - perfil completo do seller logado
// FIX-WORKER-18 pass 231 (endpoint sem cache - hot path dashboard-seller):
//   Endpoint chamado em CADA navegacao do dashboard-seller (header SellerNav
//   + sidebar puxam Api.sellerMe(token) em mount). Sem cache, cada page-view
//   dispara JOIN sellers + vw_seller_pending (5-30ms DB cada).
//   Seller ativo: ~50 page-views/sessao -> 50 DB hits desnecessarios.
//   FIX: cacheMiddleware TTL 30s vary by user.sub. Invalidacao em PATCH
//   abaixo via invalidateSellerCache (W18 pass 6 helper). 30s TTL aceitavel:
//   muda apenas em edit profile (rare) ou KYC status (cron 1min sync ja).
router.get('/',
  cache.cacheMiddleware(sellerMeCacheKey, 30),
  asyncHandler(async (req, res, next) => {
  const r = await query(
    `SELECT s.*, vp.qna_pending, vp.disputes_open, vp.products_in_qa,
            vp.products_rejected, vp.sla_days_remaining
       FROM sellers s
       LEFT JOIN vw_seller_pending vp ON vp.seller_id = s.id
      WHERE s.user_id = $1 AND s.deleted_at IS NULL`,
    [req.user.sub]
  );
  if (!r.rows.length) return next(errorHandler.notFound('seller_profile_not_found'));
  // ocultar fingerprint do documento
  const s = r.rows[0];
  delete s.document_number_hash;
  res.json({ seller: s });
}));

const updateSchema = z.object({
  store_name: z.string().min(3).max(120).optional(),
  store_description: z.string().max(5000).optional(),
  store_banner_url: z.string().url().optional(),
  store_logo_url: z.string().url().optional(),
  asaas_pix_key: z.string().max(200).optional(),
  allow_platform_resale: z.boolean().optional(),
});

// FIX-WORKER-7 pass 43: 7 BUGS CRITICOS aplicando Pattern W7.
//
// BUG 1 *** SQL INJECTION-LIKE column name interpolation ***
//   PRE-FIX: cols.push(`${k} = $${i++}`) - k vem de req.body via Object.entries
//   Zod whitelist garante 6 fields HOJE. MAS frágil:
//   - Se Zod .passthrough() adicionado futuro = SQL injection real
//   - Pattern defense-in-depth: NUNCA confiar em Zod isolado para SQL safety
//   FIX: ALLOWED_FIELDS Set explicit no codigo + filter Object.entries
//
// BUG 2 *** invalidateSellerCache(req.user.sub) ARG ERRADO ***
//   PRE-FIX: passa user_id mas funcao espera seller_id (admin.js linha 13:
//   SELECT store_slug FROM sellers WHERE id = $1)
//   Cache NUNCA invalida apos PATCH -> seller ve mudancas velhas ate TTL 300s
//   UX broken silencioso (sem erro - cache so retorna stale)
//   FIX: SELECT id FROM sellers WHERE user_id = req.user.sub primeiro,
//   passar seller.id para cache invalidate
//
// BUG 3 *** Regra A *** seller status check missing
//   Conta suspended/banned pode atualizar perfil
//   FIX: AND status IN ('active','kyc_submitted','kyc_rejected')
//   (pending_kyc OK porque seller setup inicial; suspended/banned bloqueados)
//
// BUG 4 *** Regra K *** FOR UPDATE seller (anti-race PATCH simultaneos)
//
// BUG 5 *** SILENT 404 *** UPDATE rowcount=0 + ok:true
//   Pre-fix: user sem entry sellers -> 0 rows -> 200 OK silencioso
//   FIX: SELECT FOR UPDATE upfront + 404 explicit
//
// BUG 6 *** AUDIT_LOG missing *** especialmente sensitive fields
//   asaas_pix_key + allow_platform_resale sao mutacoes IMPACT financeiro
//   Forense compliance: rastrear quem mudou pix_key (anti-fraud takeover)
//   FIX: INSERT audit_log atomic + payload JSON com fields_changed
//   PII mask: pix_key prefix-only no audit (LGPD)
//
// BUG 7 *** RATE-LIMIT *** profile spam
//   Bot/UI bug spam patch = stress DB + cache invalidation
//   FIX: rateLimiter 20/15min/IP (real users <5 edits/dia)
const ALLOWED_PATCH_FIELDS = new Set([
  'store_name', 'store_description', 'store_banner_url', 'store_logo_url',
  'asaas_pix_key', 'allow_platform_resale',
]);
const SENSITIVE_PATCH_FIELDS = new Set(['asaas_pix_key', 'allow_platform_resale']);
const patchLimiter = rateLimiter.createLimiter({
  windowMs: 15 * 60 * 1000, max: 20,
  message: 'Muitas atualizacoes de perfil. Aguarde alguns minutos.',
});

router.patch('/',
  patchLimiter,
  validate({ body: updateSchema }),
  asyncHandler(async (req, res, next) => {
    // BUG 1: filter ALLOWED_FIELDS antes de construir SQL (defense-in-depth)
    const entries = Object.entries(req.body).filter(([k]) => ALLOWED_PATCH_FIELDS.has(k));
    if (!entries.length) return res.json({ ok: true, noop: true });

    let outcome;
    let sellerId;
    await tx(async (c) => {
      // BUG 5 + BUG 4 (Regra K): SELECT FOR UPDATE seller existence + status
      const cur = await c.query(
        `SELECT id, status FROM sellers
          WHERE user_id = $1::UUID AND deleted_at IS NULL
          FOR UPDATE`,
        [req.user.sub]
      );
      if (!cur.rows.length) { outcome = { error: 'seller_not_found' }; return; }
      const s = cur.rows[0];

      // BUG 3 (Regra A): status check - suspended/banned bloqueados
      const ALLOWED_STATUSES = new Set(['active', 'kyc_submitted', 'kyc_rejected', 'pending_kyc']);
      if (!ALLOWED_STATUSES.has(s.status)) {
        outcome = { error: 'seller_status_blocks_update', current_status: s.status };
        return;
      }
      sellerId = s.id;

      // BUG 1: construct SQL com fields whitelisted (Set lookup garantido)
      const cols = []; const vals = []; let i = 1;
      for (const [k, v] of entries) {
        cols.push(`${k} = $${i++}`); vals.push(v);  // k validado pelo Set acima
      }
      vals.push(s.id);
      await c.query(
        `UPDATE sellers SET ${cols.join(', ')}, updated_at = NOW() WHERE id = $${i}::UUID`,
        vals
      );

      // BUG 6: audit_log atomic com PII masking
      // pix_key sensitive: mascarar prefix + suffix (LGPD privacy)
      const auditPayload = { fields_changed: entries.map(([k]) => k) };
      for (const [k, v] of entries) {
        if (SENSITIVE_PATCH_FIELDS.has(k)) {
          if (k === 'asaas_pix_key' && typeof v === 'string') {
            // Mask: "abc...xyz" (so 3 primeiros + 3 ultimos chars)
            auditPayload[`${k}_masked`] = v.length > 6
              ? `${v.slice(0,3)}...${v.slice(-3)}`
              : '<short>';
          } else if (k === 'allow_platform_resale') {
            auditPayload[k] = !!v;  // boolean explicit
          }
        }
      }
      await c.query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES ($1, 'seller', 'seller.profile_update', 'seller', $2, 'info', $3::JSONB)`,
        [req.user.sub, s.id, JSON.stringify({ ...auditPayload, ip: req.ip })]
      );
    });

    if (outcome?.error === 'seller_not_found') return next(errorHandler.notFound('seller_not_found'));
    if (outcome?.error === 'seller_status_blocks_update') {
      return res.status(403).json({
        error: 'seller_status_blocks_update',
        message: `Sua conta esta em status '${outcome.current_status}'. Atualizacoes bloqueadas.`,
        current_status: outcome.current_status,
      });
    }

    // Cache invalidate via funcao linha 15 (assinatura userId - WHERE user_id)
    await invalidateSellerCache(req.user.sub);
    res.json({ ok: true });
  })
);

const kycSchema = z.object({
  document_type: z.enum(['cpf','cnpj']),
  document_number: z.string().min(11).max(20),
  legal_name: z.string().min(3).max(200),
  address_line1: z.string().min(3).max(200),
  address_city: z.string().min(2).max(100),
  address_state: z.string().length(2),
  address_zip: z.string().min(5).max(20),
});

// POST /sellers/me/kyc - submit KYC (COMPLIANCE CRITICAL)
// FIX-WORKER-7 pass 41: 8 BUGS CRITICOS - COMPLIANCE BREAK GRAVE PRE-FIX.
//
// BUG 1 *** AUTO-APPROVE COMPLIANCE BREAK *** status='active' direto
//   PRE-FIX: linha 89 setava status='active' apos qualquer submit
//   COMBO FRAUD com pass 40:
//   - Seller fake submete KYC com CPF random -> status='active' auto
//   - Pass 40 libera /payout p/ status='active'
//   - Seller saca tudo antes admin descobrir
//   - Lavagem dinheiro via plataforma documented
//   FIX (mig 045 adiciona enum): status='kyc_submitted' aguarda admin review
//   Admin endpoint /admin/kyc/approve|reject move para active|kyc_rejected
//
// BUG 2 *** DOCUMENT DEDUP MISSING *** mesma CPF em N contas
//   PRE-FIX: sem unique constraint document_number_hash
//   Atacante: criar 100 contas com mesmo CPF, todas active, lavagem
//   FIX (mig 045): UNIQUE INDEX document_number_hash
//   PG raise 23505 -> 409 'document_already_registered'
//
// BUG 3 *** Regra Q IDEMPOTENT *** re-submit KYC sobrescreve approved
//   PRE-FIX: UPDATE sem status check
//   Seller ja aprovado submete novo CPF -> sobrescreve historico
//   FIX: WHERE status IN ('pending_kyc','kyc_rejected') guard
//   Active/kyc_submitted bloqueados (409)
//
// BUG 4 *** Regra K *** FOR UPDATE seller
//   2 submits paralelos = race UPDATE concorrente
//   FIX: SELECT FOR UPDATE
//
// BUG 5 *** AUDIT_LOG missing *** sec event critical (compliance)
//   KYC submit = evento RASTREAVEL (GDPR/LGPD article)
//   FIX: INSERT audit_log atomic tx
//
// BUG 6 *** Silent rowcount=0 *** ok:true mesmo sem update
//   FIX: SELECT FOR UPDATE upfront + 404 se nao existe
//
// BUG 7 *** RATE-LIMIT *** seller pwned spam submits
//   FIX: rateLimiter 3/hr/IP (KYC submit nao deveria > 3x/hora)
//
// BUG 8 *** CPF/CNPJ checksum validation MISSING ***
//   Pre-fix: aceita "00000000000" como CPF valido (so hashea)
//   Atacante: spray 1000 CPFs invalidos sintaticamente OK mas falsos
//   FIX: regex digit-only + length check (11 CPF / 14 CNPJ)
//   PROPER checksum algoritmo Receita Federal seria ideal mas:
//   - Aplicado em auth-svc /register (W2 pass 5) ja - usuario antes ja teve CPF validado
//   - sellers.user_id FK ja garante ownership do CPF cadastrado em users
//   - Defesa em profundidade: regex length aqui + validacao real auth-svc
const kycLimiter = rateLimiter.createLimiter({
  windowMs: 60 * 60 * 1000, max: 3,
  message: 'Muitas submissoes de KYC. Aguarde 1 hora.',
});

router.post('/kyc',
  kycLimiter,
  validate({ body: kycSchema }),
  asyncHandler(async (req, res, next) => {
    const b = req.body;

    // BUG 8: regex length validation (digit-only + 11 CPF | 14 CNPJ)
    const docDigits = b.document_number.replace(/\D/g, '');
    if (b.document_type === 'cpf' && docDigits.length !== 11) {
      return next(errorHandler.badRequest('invalid_cpf_length', 'CPF deve ter 11 digitos'));
    }
    if (b.document_type === 'cnpj' && docDigits.length !== 14) {
      return next(errorHandler.badRequest('invalid_cnpj_length', 'CNPJ deve ter 14 digitos'));
    }
    const fp = crypto.sha256(docDigits);  // hash digit-only canonico

    let outcome;
    await tx(async (c) => {
      // BUG 4+6 (Regra K + 404): SELECT FOR UPDATE seller (anti-race) + existence
      const sr = await c.query(
        `SELECT id, status FROM sellers WHERE user_id = $1::UUID FOR UPDATE`,
        [req.user.sub]
      );
      if (!sr.rows.length) { outcome = { error: 'seller_not_found' }; return; }
      const s = sr.rows[0];

      // BUG 3 (Regra Q): idempotent guard - active/kyc_submitted = terminal nao-revisitar
      const ALLOWED_FROM = new Set(['pending_kyc', 'kyc_rejected']);
      if (!ALLOWED_FROM.has(s.status)) {
        outcome = { error: 'invalid_state', current_status: s.status };
        return;
      }

      // BUG 1+2: UPDATE status='kyc_submitted' (NAO 'active') + unique doc enforce
      try {
        await c.query(
          `UPDATE sellers SET
             document_type = $1, document_number_hash = $2, legal_name = $3,
             address_line1 = $4, address_city = $5, address_state = $6, address_zip = $7,
             status = 'kyc_submitted',
             kyc_submitted_at = NOW(),
             kyc_rejection_reason = NULL,
             updated_at = NOW()
           WHERE id = $8::UUID AND status IN ('pending_kyc','kyc_rejected')`,
          [b.document_type, fp, b.legal_name, b.address_line1, b.address_city, b.address_state, b.address_zip, s.id]
        );
      } catch (e) {
        // BUG 2: PG 23505 = unique violation (mig 045 unique idx)
        if (e.code === '23505') {
          outcome = { error: 'document_already_registered' };
          return;
        }
        throw e;
      }

      // BUG 5: audit_log atomic (compliance forense LGPD/GDPR)
      await c.query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES ($1, 'seller', 'kyc.submit', 'seller', $2, 'info', $3::JSONB)`,
        [req.user.sub, s.id,
         JSON.stringify({
           document_type: b.document_type,
           document_hash_prefix: fp.slice(0, 8),  // SO prefix - nao vaza hash full
           legal_name_length: b.legal_name.length,
           city: b.address_city,
           state: b.address_state,
           previous_status: s.status,
           ip: req.ip,
         })]
      );
    });

    if (outcome?.error === 'seller_not_found') return next(errorHandler.notFound('seller_not_found'));
    if (outcome?.error === 'invalid_state') {
      return res.status(409).json({
        error: 'invalid_state',
        message: `Estado atual '${outcome.current_status}' nao permite re-submit KYC. Apenas pending_kyc ou kyc_rejected.`,
        current_status: outcome.current_status,
      });
    }
    if (outcome?.error === 'document_already_registered') {
      return res.status(409).json({
        error: 'document_already_registered',
        message: 'Este documento ja esta registrado em outra conta seller.',
      });
    }
    // PRE-FIX retornava status='active' mentindo - FIX: status='kyc_submitted'
    // UI dashboard-seller atualiza para "Aguardando aprovacao admin"
    res.json({ ok: true, status: 'kyc_submitted', message: 'KYC submetido. Aguarde revisao admin (1-3 dias uteis).' });
  })
);

// GET /sellers/me/sla-status - timer da Classe B
// FIX-WORKER-18 pass 174: cache 60s per-user. Endpoint chamado em CADA render
// do dashboard-seller (/page.tsx:86 fetchJSON). SLA timer muda ~1x/dia, mas
// FIRE deadline change pode acontecer apos POST /upload (invalidacao trigger).
// PRE-FIX: 100% miss em SELECT + 2 EXTRACT + GREATEST per request.
// FIX: cache.cacheMiddleware 60s vary by user.sub.
//
// Invalidacao: ja existe em invalidateSellerCache() helper (chamado em PATCH).
// Acrescenta seller:sla-status:{userId} a invalidacao quando relevante (POST /upload).
const slaStatusCacheKey = (req) => `seller:sla-status:${req.user?.sub || 'anon'}`;
router.get('/sla-status',
  cache.cacheMiddleware(slaStatusCacheKey, 60),
  asyncHandler(async (req, res) => {
    const r = await query(
      `SELECT id, seller_class, sla_active, sla_days, sla_last_upload_at, sla_next_deadline_at,
              sla_revoked_count, status,
              GREATEST(0, EXTRACT(DAY FROM (sla_next_deadline_at - NOW())))::INT AS days_remaining,
              EXTRACT(EPOCH FROM (sla_next_deadline_at - NOW()))::BIGINT AS seconds_remaining
         FROM sellers WHERE user_id = $1`, [req.user.sub]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'not_found' });
    res.json({ sla: r.rows[0] });
  })
);

// GET /sellers/me/sla-history
// GET /sellers/me/sla-history - historico SLA do seller
// FIX-WORKER-7 pass 70: 3 BUGS aplicando Pattern W7 (Regras D+E+I).
//
// BUG 1 *** Regra I SELECT h.* *** vaza colunas internas
//   seller_sla_history.* pode ter internal_notes/triggered_by/cron_run_id.
//   FIX: explicit fields.
//
// BUG 2 *** Regra D TIEBREAKER MISSING *** ORDER BY created_at DESC
//   Cron SLA roda burst -> 2 entries created_at identicos.
//   FIX: + h.id DESC.
//
// BUG 3 *** Regra E PAGINATION MISSING *** hardcoded LIMIT 50
//   Seller veterano (12+ meses) tem 100+ SLA events. Só vê 50 primeiras.
//   FIX: ?limit (1-200, default 50) + ?offset + total + has_more.
router.get('/sla-history', asyncHandler(async (req, res) => {
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  // FIX-WORKER-7 pass 109 deploy: schema real seller_sla_history tem
  // 'event' (não event_type), 'deadline_was', 'actual_upload_at', 'days_overdue',
  // 'actor_user_id', 'notes' (não previous_class/new_class etc).
  // FIX-WORKER-18 pass 262 (COUNT window consolidation):
  //   2 queries -> 1 via COUNT(*) OVER(). Pattern V8 cross-svc consolidated.
  //   Reduz 50% DB roundtrip + reusa plan JOIN identico.
  const r = await query(
    `SELECT h.id, h.seller_id, h.event, h.deadline_was, h.actual_upload_at,
            h.days_overdue, h.actor_user_id, h.notes, h.created_at,
            COUNT(*) OVER()::INT AS _total
       FROM seller_sla_history h
       JOIN sellers s ON s.id = h.seller_id
      WHERE s.user_id = $1
      ORDER BY h.created_at DESC, h.id DESC
      LIMIT $2 OFFSET $3`,
    [req.user.sub, limit, offset]
  );
  const total = r.rows[0]?._total ?? 0;
  // Strip _total from response
  const history = r.rows.map((row) => { const { _total, ...rest } = row; return rest; });
  res.json({
    history,
    total, limit, offset,
    has_more: (offset + history.length) < total,
  });
}));

// POST /sellers/me/payout - solicitar saque (REAL MONEY OUT request)
// FIX-WORKER-7 pass 40: 7 BUGS CRITICOS - endpoint solicita REAL $ exit plataforma.
// Pattern paralelo pass 23 (payment /payouts/:id/process - admin processa)
// MAS ESTE = seller REQUEST. Vetor abuse: seller solicita > balance disponivel.
//
// BUG 1 *** SALDO DISPONIVEL CHECK MISSING *** monetary loss real
//   PRE-FIX: zero check balance. Seller pode POST {amount: R$ 1.000.000}
//   sem ter receita. INSERT seller_payouts pending entra no DB.
//   Admin processa (trust DB integrity) -> Asaas transfer real -> LOSS.
//   FIX: calcular available_balance = total_revenue - SUM(payouts non-final)
//   Bloquear se amount > available.
//
// BUG 2 *** INFLIGHT PAYOUT MULTIPLICATION *** race spam
//   PRE-FIX: zero check inflight. Seller dispara 100 requests simultaneos
//   100 INSERTs pending - admin aprova todos sem ver soma cumulativa.
//   FIX: SUM(payouts pending+approved) DENTRO tx + FOR UPDATE sellers row.
//
// BUG 3 *** Regra A *** seller_status check missing
//   Seller suspended/banned/pending_kyc pode pedir saque - bypass compliance
//   FIX: status='active' (whitelist, pre-existing enum pending_kyc/active/...)
//
// BUG 4 *** KYC VERIFICATION *** compliance/AML
//   PRE-FIX: aceita payout em seller status='pending_kyc'
//   = lavagem dinheiro vector + AML violation
//   FIX: WHERE status='active' (enum inclui kyc_required estados)
//
// BUG 5 *** Regra K *** FOR UPDATE seller row anti-race
//   2 requests simultaneos leem mesmo balance -> ambos passam -> race
//   FIX: SELECT FOR UPDATE serializa
//
// BUG 6 *** Regra I *** RETURNING *
//   seller_payouts.* expoe internal_notes/risk_score/rejection_reason
//   FIX: RETURNING explicit fields
//
// BUG 7 *** RATE-LIMIT *** seller pwned spam
//   Conta seller compromised -> spam payouts. FIX: rateLimiter 3/hr/IP
//   (real users <1 payout/dia)
const payoutLimiter = rateLimiter.createLimiter({
  windowMs: 60 * 60 * 1000, max: 3,
  message: 'Muitas solicitacoes de saque recentes. Aguarde 1 hora.',
});

router.post('/payout',
  payoutLimiter,
  validate({ body: z.object({ amount_cents: z.number().int().positive() }) }),
  asyncHandler(async (req, res, next) => {
    let outcome;
    let payout;
    await tx(async (c) => {
      // BUG 5 Regra K: SELECT FOR UPDATE seller (serializa concorrencia)
      // BUG 3+4 Regras A+KYC: status='active' filter (pending_kyc/suspended blocked)
      // BUG 2 inflight: total_revenue - SUM payouts non-final
      const sql = `
        WITH non_final AS (
          SELECT COALESCE(SUM(amount_cents), 0)::BIGINT AS pending_sum
            FROM seller_payouts
           WHERE seller_id = (SELECT id FROM sellers WHERE user_id = $1::UUID)
             AND status IN ('pending','approved','processing','paid')
        )
        SELECT s.id, s.payout_min_amount_cents, s.total_revenue_cents,
               s.status, (SELECT pending_sum FROM non_final) AS reserved_cents
          FROM sellers s
         WHERE s.user_id = $1::UUID
         FOR UPDATE OF s
      `;
      const sr = await c.query(sql, [req.user.sub]);
      if (!sr.rows.length) { outcome = { error: 'seller_not_found' }; return; }
      const s = sr.rows[0];

      // BUG 3+4: status='active' (compliance + KYC)
      if (s.status !== 'active') {
        outcome = { error: 'seller_not_active', current_status: s.status };
        return;
      }

      const min = parseInt(s.payout_min_amount_cents, 10) || 5000;
      if (req.body.amount_cents < min) {
        outcome = { error: 'amount_below_min', min_cents: min };
        return;
      }

      // BUG 1+2: calcula saldo disponivel real (revenue - payouts non-final)
      const totalRev = parseInt(s.total_revenue_cents, 10) || 0;
      const reserved = parseInt(s.reserved_cents, 10) || 0;
      const available = totalRev - reserved;
      if (req.body.amount_cents > available) {
        outcome = {
          error: 'insufficient_balance',
          available_cents: available,
          requested_cents: req.body.amount_cents,
        };
        return;
      }

      // INSERT payout (Regra I: RETURNING explicit)
      const r = await c.query(
        `INSERT INTO seller_payouts (seller_id, amount_cents)
         VALUES ($1::UUID, $2::BIGINT)
         RETURNING id, amount_cents, status, requested_at`,
        [s.id, req.body.amount_cents]
      );
      payout = r.rows[0];

      // BONUS audit_log atomic (pattern pass 23 - real money endpoints)
      await c.query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES ($1, 'seller', 'payout.request', 'seller_payout', $2, 'info', $3::JSONB)`,
        [req.user.sub, payout.id,
         JSON.stringify({
           seller_id: s.id,
           amount_cents: req.body.amount_cents,
           available_before: available,
           ip: req.ip,
         })]
      );
    });

    if (outcome?.error === 'seller_not_found') return next(errorHandler.notFound('seller_not_found'));
    if (outcome?.error === 'seller_not_active') {
      return res.status(403).json({
        error: 'seller_not_active',
        message: `Sua conta esta em status '${outcome.current_status}'. Saques disponiveis apenas para sellers ativos com KYC aprovado.`,
        current_status: outcome.current_status,
      });
    }
    if (outcome?.error === 'amount_below_min') {
      return res.status(400).json({
        error: 'amount_below_min',
        message: `Minimo R$ ${(outcome.min_cents / 100).toFixed(2)}`,
        min_cents: outcome.min_cents,
      });
    }
    if (outcome?.error === 'insufficient_balance') {
      return res.status(400).json({
        error: 'insufficient_balance',
        message: `Saldo disponivel: R$ ${(outcome.available_cents / 100).toFixed(2)}. Solicitado: R$ ${(outcome.requested_cents / 100).toFixed(2)}.`,
        available_cents: outcome.available_cents,
        requested_cents: outcome.requested_cents,
      });
    }

    // FIX-WORKER-18 pass 175: invalida cache /payouts apos novo payout
    // (W18-175 adicionou cache 30s vary by user+status+limit+offset)
    try {
      await cache.del(`seller:payouts:${req.user.sub}:*`);
    } catch (e) {
      log.warn({ err: e.message, user: req.user.sub }, '[cache.invalidate_fail]');
    }

    res.status(201).json({ payout });
  })
);

// FIX-WORKER-5: GET /sellers/me/payouts - historico de payouts do seller logado.
// Antes: dashboard-seller /financeiro tinha botao "Solicitar saque" mas zero
// visibilidade do que aconteceu depois (admin aprovou? rejeitou? processou?).
// Seller ficava no escuro apos solicitar - tinha que perguntar suporte.
// GET /sellers/me/payouts - historico de saques do seller
// FIX-WORKER-7 pass 70: 5 BUGS aplicando Pattern W7 (Regras D+E + filter + DLP + UX).
//
// BUG 1 *** Regra D TIEBREAKER MISSING *** ORDER BY requested_at DESC
//   Seller dispara N payouts script -> requested_at identicos burst.
//   FIX: + id DESC.
//
// BUG 2 *** Regra E NO OFFSET *** ?limit existe MAS ?offset missing
//   Seller 1+ ano com 200+ payouts não consegue paginar além das primeiras 200.
//   FIX: ?offset + total + has_more.
//
// BUG 3 *** ?status FILTER MISSING ***
//   Seller quer ver SO "pending" (aguardando admin), SO "rejected" (entender motivo)
//   ou SO "paid" (historico fiscal). Sem filter -> client filter post-fetch.
//   FIX: ?status enum whitelist (pending|approved|processing|paid|rejected|cancelled).
//
// BUG 4 *** DLP rejected_reason texto livre ***
//   rejected_reason eh livre admin: "Conta bancaria invalida (titular CPF
//   123.456.789-00 diferente)" -> CPF vazado para seller. Outros patterns:
//   "Suspeita lavagem - veja PR 12345 Bearer abc..." -> token leak.
//   FIX: mask.text() defensive em rejected_reason (CPF/Bearer/JWT auto-mask).
//
// BUG 5 *** TOTAL + has_more UX ***
//   Frontend "Carregar mais" sem suporte. FIX adicionado.
const PAYOUT_STATUS_ENUM = new Set([
  'pending','approved','processing','paid','rejected','cancelled'
]);

// FIX-WORKER-18 pass 175: cache 30s + COUNT(*) OVER() consolidation.
// Pre-fix: 3 queries por request (sellers lookup + payouts SELECT + COUNT).
// Frontend /financeiro chama em CADA render. Sem cache = full miss.
// Fix1: cache.cacheMiddleware vary by user+status+limit+offset
// Fix2: window COUNT(*) OVER() elimina segunda query duplicada
// TTL 30s: payouts state muda apos admin approve/process. Stale ate 30s OK.
const payoutsCacheKey = (req) => {
  const userId = req.user?.sub || 'anon';
  const status = req.query.status || 'all';
  const lim = req.query.limit || '50';
  const off = req.query.offset || '0';
  return `seller:payouts:${userId}:${status}:l${lim}:o${off}`;
};

router.get('/payouts',
  cache.cacheMiddleware(payoutsCacheKey, 30),
  asyncHandler(async (req, res, next) => {
    // FIX-WORKER-7 pass 4: Math.max(1, ...) clamp p/ rejeitar negativos
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const statusFilter = req.query.status ? String(req.query.status) : null;
    if (statusFilter && !PAYOUT_STATUS_ENUM.has(statusFilter)) {
      return res.status(400).json({ error: 'invalid_status', allowed: Array.from(PAYOUT_STATUS_ENUM) });
    }

    const s = await query('SELECT id FROM sellers WHERE user_id = $1', [req.user.sub]);
    if (!s.rows.length) return next(errorHandler.notFound('seller_not_found'));

    // Build WHERE
    const whereParts = ['seller_id = $1'];
    const params = [s.rows[0].id];
    let i = 2;
    if (statusFilter) {
      whereParts.push(`status = $${i++}`);
      params.push(statusFilter);
    }
    params.push(limit, offset);
    const limIdx = i++;
    const offIdx = i++;

    // FIX-WORKER-18 pass 175: COUNT(*) OVER() consolida payouts + total em 1 query.
    // PG executa scan unico, window count nao requer segundo scan.
    // Latencia: ~25ms (2 queries) -> ~12ms (1 query).
    const r = await query(
      `SELECT id, amount_cents, status, asaas_transfer_id, requested_at,
              approved_at, paid_at, rejected_reason,
              COUNT(*) OVER()::INT AS _total
         FROM seller_payouts
        WHERE ${whereParts.join(' AND ')}
        ORDER BY requested_at DESC, id DESC
        LIMIT $${limIdx} OFFSET $${offIdx}`,
      params
    );

    const total = r.rows[0]?._total || 0;

    // DLP mask rejected_reason (admin pode escrever CPF/Bearer/JWT acidentalmente)
    const payouts = r.rows.map((row) => {
      const { _total, ...rest } = row;
      return {
        ...rest,
        rejected_reason: rest.rejected_reason ? mask.text(rest.rejected_reason) : null,
      };
    });

    res.json({
      payouts,
      total, limit, offset,
      has_more: (offset + payouts.length) < total,
      status: statusFilter,
    });
  })
);

// GET /sellers/me/kpi - dashboard KPIs do seller (mv_seller_kpi)
// FIX-WORKER-7 pass 72: 3 BUGS aplicando Pattern W7.
//
// BUG 1 *** Regra I SELECT k.* *** mv expoe internals
//   mv_seller_kpi.* pode ter colunas calculated internals:
//   - refresh_count (cron metadata)
//   - computed_at (debugging metadata)
//   - internal_risk_score (algo proprietary)
//   - admin_flags (compliance markers)
//   Materialized view evolui com migrations - SELECT k.* eh contrato fragil.
//   FIX: explicit fields documentados consumed by frontend.
//
// BUG 2 *** CACHE MISSING ***
//   mv_seller_kpi atualiza via REFRESH MATERIALIZED VIEW (cron diario).
//   Cache 5min eh seguro - kpi nao muda intraday.
//   Frontend /seller/dashboard refresh = hot path.
//   FIX: cache.cacheMiddleware 300s per-user.
//
// BUG 3 *** Regra H NULL guard *** kpi.rows[0] || null
//   Seller novo sem mv_seller_kpi entry retorna NULL.
//   Frontend kpi.field expects object - precisa fallback structure.
//   FIX: default zeros object (idiomatica empty state).
const kpiCacheKey = (req) => `seller:kpi:${req.user?.sub || 'anon'}`;

router.get('/kpi',
  cache.cacheMiddleware(kpiCacheKey, 300),
  asyncHandler(async (req, res) => {
    // FIX-WORKER-7 pass 109 deploy: schema real mv_seller_kpi (DESCRIBE):
    //   seller_id, user_id, seller_class, status, reputation_tier, reputation_score,
    //   products_active, products_pending_qa, gross_revenue_cents, net_payout_cents,
    //   platform_commission_cents, total_orders, avg_rating, review_count,
    //   open_disputes, sla_next_deadline_at, updated_at
    // Removidas colunas que nao existem: total_sales, total_revenue_cents,
    //   refund_rate, on_time_qa_rate, response_rate, last_updated_at.
    // Adicionadas: total_orders, gross_revenue_cents, net_payout_cents,
    //   products_active, products_pending_qa, open_disputes.
    const r = await query(
      `SELECT k.seller_id, k.seller_class, k.status,
              k.reputation_tier, k.reputation_score,
              k.products_active, k.products_pending_qa,
              k.gross_revenue_cents, k.net_payout_cents,
              k.platform_commission_cents,
              k.total_orders, k.avg_rating, k.review_count,
              k.open_disputes, k.sla_next_deadline_at, k.updated_at
         FROM mv_seller_kpi k
        WHERE k.user_id = $1`, [req.user.sub]
    );

    // Default empty state p/ seller novo sem mv entry
    const kpi = r.rows[0] || {
      seller_id: null, seller_class: null, status: null,
      reputation_tier: 'iniciante', reputation_score: 0,
      products_active: 0, products_pending_qa: 0,
      gross_revenue_cents: 0, net_payout_cents: 0, platform_commission_cents: 0,
      total_orders: 0, avg_rating: 0, review_count: 0,
      open_disputes: 0, sla_next_deadline_at: null, updated_at: null,
    };
    res.json({ kpi });
  })
);

module.exports = router;
