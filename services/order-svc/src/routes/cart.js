'use strict';

const express = require('express');
const { z } = require('zod');
const { query, tx } = require('@cas/db-client');
const { jwt, asyncHandler, validate, errorHandler, cache, withRetry } = require('@cas/shared');

const router = express.Router();
router.use(jwt.requireAuth());

// GET /orders/cart - carrinho atual do user
// FIX-WORKER-7 pass 104: 5 BUGS aplicando Pattern W7 (Regras A+B+I + N+1 + COALESCE).
//
// BUG 1 *** Regra I SELECT c.* *** carts.* expoe colunas internas
//   carts table pode ter abandoned_at_cron / coupon_applied_metadata / etc.
//   FIX: explicit fields (id, user_id, subtotal_cents, discount_cents,
//   loyalty_points_redeemed, coupon_code, updated_at).
//
// BUG 2 *** Regra A products status MISSING ***
//   PRE-FIX: cart_items JOIN products p sem filter status.
//   Cenario: product foi rejected/archived apos user adicionar -> aparece
//   no carrinho como if available (UX confuso, checkout falha later).
//   FIX: + AND p.status IN ('approved','platform_owned') na subquery.
//
// BUG 3 *** Regra B products deleted_at MISSING ***
//   Mesmo cenario - product deletado -> ainda no carrinho stale.
//   FIX: + AND p.deleted_at IS NULL.
//
// BUG 4 *** N+1 SUBQUERY seller_name ***
//   (SELECT store_name FROM sellers WHERE id = p.seller_id) per cart_item.
//   10 items = 10 subqueries adicionais.
//   FIX: LEFT JOIN sellers s ON s.id = p.seller_id na subquery aggregate.
//
// BUG 5 *** Regra H json_agg NULL guard ***
//   PRE-FIX: cart vazio -> items NULL no response. Frontend .items.map crash.
//   FIX: COALESCE(json_agg(...) FILTER (WHERE ci.id IS NOT NULL), '[]'::JSON).
router.get('/', asyncHandler(async (req, res) => {
  await query(
    `INSERT INTO carts (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [req.user.sub]
  );
  const c = await query(
    `SELECT c.id, c.user_id, c.subtotal_cents, c.discount_cents,
            c.loyalty_points_redeemed, c.coupon_code, c.updated_at,
      /* FIX-WORKER-2 pass 640 (cart items json_agg ORDER BY ASC+ASC determinism):
         PRE-FIX: cart_items json_agg sem ORDER BY - PG heap order arbitrario.
         - User adiciona prodA, prodB, prodC ao carrinho (3 cliques sequenciais)
         - Refresh /cart page tab 1: items [A, B, C]
         - Refresh tab 2 (cache evict): items [C, A, B]
         - UX CRITICO: user mentally tracks "primeiro item = prod A"
         - Mudanca arbitraria de ordem = confusao + remove item errado clicando trash icon
         - Buyer pode duplicar acidentalmente removendo wrong item -> rebuy CTA -> double-charge risk
         POST-FIX: + ORDER BY ci.created_at, ci.id ASC+ASC determinism FIFO.
         - cart_items.created_at chronologic - mais antigo primeiro (insert order natural)
         - tiebreaker ci.id ASC dentro mesmo timestamp (anti race-add)
         - mig 010 idx_cart_items_cart_id cobre WHERE filter, ORDER inline ok p/ <20 items typical */
      COALESCE(
        (SELECT json_agg(json_build_object(
           'id', ci.id, 'product_id', ci.product_id, 'quantity', ci.quantity,
           'unit_price_cents', ci.unit_price_cents, 'line_total_cents', ci.line_total_cents,
           'product', json_build_object(
             'title', p.title, 'slug', p.slug, 'cover_image_url', p.cover_image_url,
             'kind', p.kind, 'is_platform_owned', p.is_platform_owned,
             'seller_name', s.store_name,
             /* FIX-WORKER-11 pass 278: expoe flag para cart UI alertar buyer
                qd seller sem asaas_wallet_id (payout entra debt queue).
                Boolean explicito - true=split direto, false=fallback queue. */
             'seller_wallet_configured', (s.asaas_wallet_id IS NOT NULL AND s.asaas_wallet_id <> '')
           )
         ) ORDER BY ci.created_at, ci.id)
         FROM cart_items ci
         JOIN products p ON p.id = ci.product_id
                       AND p.status IN ('approved','platform_owned')
                       AND p.deleted_at IS NULL
         LEFT JOIN sellers s ON s.id = p.seller_id
        WHERE ci.cart_id = c.id),
        '[]'::JSON
      ) AS items
     FROM carts c WHERE c.user_id = $1`, [req.user.sub]
  );
  res.json({ cart: c.rows[0] });
}));

// POST /orders/cart/items
// FIX-WORKER-3 pass 2: quantity max 99 (era apenas positive() -> aceitava 99999+,
// permitindo abuse para inflar line_total_cents BIGINT + DoS cart calc).
// UI cart-drawer ja tinha cap em 99, agora backend valida tambem.
router.post('/items',
  validate({ body: z.object({
    product_id: z.string().uuid(),
    quantity: z.number().int().min(1).max(99).default(1),
  })}),
  asyncHandler(async (req, res, next) => {
    // FIX-WORKER-7 pass 16 (Regra B violada - CRITICAL WRITE PATH):
    // Endpoint de ESCRITA permitia adicionar produto deletado ao carrinho.
    // Cenario real:
    //   1. User abre PDP do produto X
    //   2. Admin deleta produto X (UPDATE products SET deleted_at = NOW())
    //   3. User ainda na aba PDP clica "Adicionar ao carrinho"
    //   4. Query verificava status mas NAO deleted_at
    //   5. Produto deletado vai pro cart -> checkout -> pagamento (!!)
    //   6. Download token gerado para produto inexistente
    // CRITICIDADE: maior que endpoints de leitura - causa orders fantasma.
    // FIX: deleted_at IS NULL no WHERE (Regra B canonica).
    const p = await query(
      `SELECT id, price_cents, currency, status, title FROM products
        WHERE id = $1 AND deleted_at IS NULL`,
      [req.body.product_id]
    );
    if (!p.rows.length || !['approved','platform_owned'].includes(p.rows[0].status))
      return next(errorHandler.notFound('product_not_available'));

    const product = p.rows[0];
    const line_total = product.price_cents * req.body.quantity;

    // FIX-WORKER-2 pass 678 (withRetry cart add item deadlock defense)
    await withRetry('cart.add_item.tx', async () => await tx(async (c) => {
      const cart = await c.query(
        `INSERT INTO carts (user_id) VALUES ($1)
         ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()
         RETURNING id`, [req.user.sub]
      );
      const cart_id = cart.rows[0].id;
      await c.query(
        `INSERT INTO cart_items (cart_id, product_id, quantity, unit_price_cents, line_total_cents)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (cart_id, product_id) DO UPDATE SET
           quantity = cart_items.quantity + EXCLUDED.quantity,
           line_total_cents = cart_items.unit_price_cents * (cart_items.quantity + EXCLUDED.quantity)`,
        [cart_id, product.id, req.body.quantity, product.price_cents, line_total]
      );
      await recalcCart(c, cart_id);
    }));
    res.status(201).json({ ok: true });
  })
);

// DELETE /orders/cart/items/:id - remove item do carrinho
// FIX-WORKER-7 pass 104: 2 BUGS aplicando Pattern W7 (UUID + silent 404).
//
// BUG 1 *** UUID VALIDATE MISSING *** PG 22P02 -> 500 leak
//   PRE-FIX: req.params.id direto na query - 'invalid' -> PG cast fail.
//   FIX: CART_ITEM_UUID_RE.test() upfront.
//
// BUG 2 *** SILENT 404 ***
//   PRE-FIX: DELETE rowcount=0 retorna {ok:true} (item nao existia
//   ou pertence a outro user). UX confuso: frontend pensa removeu mas
//   item ainda aparece (na verdade nunca existia).
//   FIX: check rowcount + 404 cart_item_not_found explicit.
const CART_ITEM_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.delete('/items/:id', asyncHandler(async (req, res, next) => {
  if (!CART_ITEM_UUID_RE.test(req.params.id)) {
    return next(errorHandler.notFound('cart_item_not_found'));
  }

  // FIX-WORKER-2 pass 679 (withRetry cart delete item deadlock defense)
  let removed = false;
  await withRetry('cart.delete_item.tx', async () => await tx(async (c) => {
    const r = await c.query(
      `DELETE FROM cart_items WHERE id = $1 AND cart_id IN (SELECT id FROM carts WHERE user_id = $2) RETURNING cart_id`,
      [req.params.id, req.user.sub]
    );
    if (r.rows.length) {
      removed = true;
      await recalcCart(c, r.rows[0].cart_id);
    }
  }));

  if (!removed) return next(errorHandler.notFound('cart_item_not_found'));
  res.json({ ok: true });
}));

// PATCH /orders/cart/items/:id - atualiza quantidade absoluta + recalcula totals
// FIX-WORKER-2: introducao do endpoint (era so remove/re-add).
// FIX-WORKER-7 pass 105: 2 BUGS aplicando Pattern W7 (UUID + Regra A+B product check).
//
// BUG 1 *** UUID VALIDATE MISSING *** PG 22P02 -> 500 leak
//   PRE-FIX: req.params.id direto em $2::UUID - 'invalid' -> PG cast fail.
//   FIX: CART_ITEM_UUID_RE.test() upfront (reusa do DELETE pass 104).
//
// BUG 2 *** PRODUCT STATUS/DELETED CHECK MISSING ***
//   PRE-FIX: PATCH quantity recalcula line_total_cents = unit_price * quantity.
//   Cenario: product foi rejected/archived/deleted apos add. User clica +
//   no cart -> quantity patched + recalcCart re-soma (subtotal_cents).
//   Inconsistencia: GET /cart filtra product status (pass 104) e exclui item,
//   mas PATCH ainda permite incrementar item invisivel.
//   FIX: JOIN products no UPDATE - se product invalid, rowcount=0 -> 404.
router.patch('/items/:id',
  validate({ body: z.object({ quantity: z.number().int().min(1).max(99) }) }),
  asyncHandler(async (req, res, next) => {
    // BUG 1: UUID validate upfront
    if (!CART_ITEM_UUID_RE.test(req.params.id)) {
      return next(errorHandler.notFound('cart_item_not_found'));
    }

    // FIX-WORKER-2 pass 680 (withRetry cart PATCH qty deadlock defense)
    let cartId;
    await withRetry('cart.patch_qty.tx', async () => await tx(async (c) => {
      // BUG 2: UPDATE com JOIN products check (Regra A+B)
      // Cart_item WHERE id matches MAS product NAO mais available -> rowcount=0
      const r = await c.query(
        `UPDATE cart_items ci SET
            quantity = $1::INT,
            line_total_cents = ci.unit_price_cents * $1::INT
          WHERE ci.id = $2::UUID
            AND ci.cart_id IN (SELECT id FROM carts WHERE user_id = $3::UUID)
            AND EXISTS (
              SELECT 1 FROM products p
              WHERE p.id = ci.product_id
                AND p.status IN ('approved','platform_owned')
                AND p.deleted_at IS NULL
            )
          RETURNING ci.cart_id`,
        [req.body.quantity, req.params.id, req.user.sub]
      );
      if (!r.rows.length) return;
      cartId = r.rows[0].cart_id;
      await recalcCart(c, cartId);
    }));
    if (!cartId) return next(errorHandler.notFound('cart_item_not_found_or_product_unavailable'));
    res.json({ ok: true });
  })
);

// MLB-11: preview do cupom progressivo - retorna tiers ordenados e tier atual baseado em subtotal informado
// MLB++: tambem retorna min_tier do cupom + tier do user pra UI exibir badge 'Exclusivo Gold'
// FIX-WORKER-18 pass 7: cache 30s para /coupon/:code/preview.
// Endpoint hit a cada keystroke no checkout coupon input (com debounce frontend ~300ms).
// User digitando 10 chars = 10+ hits por cupom em <10s.
// TTL 30s baixo porque used_count/is_active podem mudar mas refresh suficiente.
// Cache key inclui code + subtotal + user.tier porque min_tier check varia por loyalty tier.
// Router tem jwt.requireAuth() global - req.user.sub sempre presente.
// FIX-WORKER-7 pass 105: 3 BUGS aplicando Pattern W7 (input validation + NaN guard + DLP).
//
// BUG 1 *** CODE LENGTH + FORMAT MISSING ***
//   PRE-FIX: req.params.code direto - bot envia 10000 chars = DoS Redis cache
//   key + DB query cost. Atacante tambem injeta ';DROP TABLE' (PG safe via
//   parametrizado mas cache key pollution).
//   FIX: regex whitelist [A-Z0-9_-]{3,40} antes de cache hit.
//
// BUG 2 *** ?subtotal_cents NaN GUARD ***
//   PRE-FIX: parseInt('abc') = NaN -> activeTierIdx loop quebra
//   (NaN >= NaN === false em todos tiers -> activeTierIdx=-1 silent).
//   FIX: Number.isFinite check + 400 invalid_subtotal_cents.
//
// BUG 3 *** DLP CACHE KEY *** code raw em Redis key
//   PRE-FIX: cache key 'coupon:preview:WIN10:s=...' - admin com Redis MONITOR
//   ve cupons tentados por users (potential pre-disclose codes ainda nao ativos).
//   FIX: SHA-256 hash 16 chars (lookups O(1) sem leak content).
//   Pattern reaplicavel cross-svc (autocomplete pass 92 estabeleceu).
const COUPON_CODE_RE = /^[A-Z0-9_-]{3,40}$/i;

router.get('/coupon/:code/preview',
  // Validate code antes do cache hit (precedence)
  (req, res, next) => {
    if (!COUPON_CODE_RE.test(String(req.params.code || ''))) {
      return res.status(400).json({ error: 'invalid_coupon_code', format: 'A-Z0-9_- 3-40 chars' });
    }
    next();
  },
  // FIX-WORKER-7 pass 16: cache key uppercase (case-insensitive MLB).
  // FIX-WORKER-7 pass 105: hash defensive (DLP - cache key nao expoe code).
  cache.cacheMiddleware((req) => {
    const code = (req.params.code || '').toUpperCase();
    const crypto = require('node:crypto');
    const codeHash = crypto.createHash('sha256').update(code).digest('hex').slice(0, 16);
    return `coupon:preview:${codeHash}:s=${req.query.subtotal_cents || 0}:u=${req.user?.sub || 'anon'}`;
  }, 30),
  asyncHandler(async (req, res, next) => {
  // BUG 2: NaN guard subtotal_cents
  const subtotalRaw = req.query.subtotal_cents;
  const subtotal = subtotalRaw !== undefined ? parseInt(subtotalRaw, 10) : 0;
  if (!Number.isFinite(subtotal) || subtotal < 0) {
    return res.status(400).json({ error: 'invalid_subtotal_cents', message: 'subtotal_cents deve ser inteiro >= 0' });
  }
  // FIX-WORKER-7 pass 16: UPPER(code) na query (case-insensitive lookup).
  // Coupon table store code uppercase por convencao - garante match.
  const c = await query(
    `SELECT code, discount_type, discount_value, tier_breakpoints, expires_at, min_tier
       FROM coupons
      WHERE UPPER(code) = UPPER($1) AND is_active
        AND (starts_at IS NULL OR starts_at <= NOW())
        AND (expires_at IS NULL OR expires_at > NOW())
        AND (max_uses IS NULL OR used_count < max_uses)`,
    [req.params.code]
  );
  if (!c.rows.length) return next(errorHandler.notFound('coupon_invalid'));
  const cp = c.rows[0];
  const tiers = Array.isArray(cp.tier_breakpoints) ? [...cp.tier_breakpoints].sort((a,b)=>Number(a.min_cents)-Number(b.min_cents)) : [];
  let activeTierIdx = -1;
  for (let i = 0; i < tiers.length; i++) if (subtotal >= Number(tiers[i].min_cents)) activeTierIdx = i;
  const effectiveValue = activeTierIdx >= 0
    ? parseFloat(tiers[activeTierIdx].discount_value)
    : parseFloat(cp.discount_value);
  const discount = cp.discount_type === 'percentage'
    ? Math.floor(subtotal * (effectiveValue / 100))
    : Math.floor(effectiveValue * 100);
  // MLB++: check eligibility por tier se aplicavel
  let eligible = true;
  let userTier = null;
  if (cp.min_tier && req.user?.sub) {
    const ur = await query(`SELECT tier FROM user_loyalty WHERE user_id = $1::UUID`, [req.user.sub]);
    userTier = ur.rows[0]?.tier || 'starter';
    const rank = { starter: 0, gold: 1, platinum: 2 };
    eligible = (rank[userTier] ?? 0) >= (rank[cp.min_tier] ?? 0);
  }

  res.json({
    coupon: { code: cp.code, discount_type: cp.discount_type, expires_at: cp.expires_at, min_tier: cp.min_tier },
    tiers,
    active_tier_index: activeTierIdx,
    effective_value: effectiveValue,
    discount_cents: discount,
    next_tier: tiers[activeTierIdx + 1] || null,
    eligible,
    user_tier: userTier,
  });
}));

// Ranking dos tiers para validar 'min_tier' (mais alto >= min eh OK)
const TIER_RANK = { starter: 0, gold: 1, platinum: 2 };

// POST /orders/cart/coupon - aplicar cupom ao carrinho
// FIX-WORKER-7 pass 16: SELECT explicit + UPPER case-insensitive.
// FIX-WORKER-7 pass 106: 4 BUGS adicionais aplicando Pattern W7.
//
// BUG 1 *** CODE FORMAT VALIDATION MISSING ***
//   PRE-FIX: z.string() aceita 10k chars + chars suspeitos. PG safe via $1
//   MAS DB query desperdicio + audit_log payload gigante.
//   Tambem: atacante bot enviando 1000 codes invalidos por seg = DB load DoS.
//   FIX: regex whitelist [A-Z0-9_-]{3,40} (mesmo do preview pass 105).
//
// BUG 2 *** RATE-LIMIT MISSING ***
//   PRE-FIX: zero limit. Bot brute-force valida codes (1000 tries/seg
//   detecta WIN10/PROMO2024 etc via timing diff valid vs invalid).
//   FIX: couponApplyLimiter 30/hr/user (real users tentam 1-2 codes).
//
// BUG 3 *** Regra K *** SELECT coupon + SELECT user_loyalty + UPDATE carts NON-ATOMIC
//   PRE-FIX: 3 statements separados. Race:
//   - /coupon + /items concorrente -> cart.subtotal stale durante validation
//   - 2 /coupon simultaneos (multi-tab) -> last write wins (coupon_code overwrite)
//   FIX: tx() wrap + SELECT FOR UPDATE em carts.
//
// BUG 4 *** Regra P AUDIT LOG MISSING ***
//   Aplicar cupom = mudanca financeira em cart (impacta checkout final $).
//   Forense: detectar abuso (multi-cupom + reset attempts).
//   FIX: INSERT audit_log atomic best-effort com code+discount_type+min_tier+ip.
const couponApplyLimiter = require('@cas/shared').rateLimiter.createLimiter({
  windowMs: 60 * 60 * 1000, max: 30,
  message: 'Muitas tentativas de cupom recentes. Aguarde 1 hora.',
});

router.post('/coupon',
  couponApplyLimiter,
  validate({ body: z.object({
    code: z.string().regex(/^[A-Z0-9_-]{3,40}$/i, 'Cupom invalido (formato: A-Z0-9_- 3-40 chars)'),
  }) }),
  asyncHandler(async (req, res, next) => {
    // FIX-WORKER-7 pass 16: SELECT explicit + UPPER case-insensitive.
    // FIX-WORKER-14 pass 352: + coupon.id + max_uses_per_user
    //   coupons table tem coluna max_uses_per_user (mig 006 linha 211) MAS
    //   endpoint NUNCA validava -> user podia aplicar/reaplicar mesmo cupom
    //   N+1 vezes (UX bug + abuse vector p/ cupons %50 high-value).
    //   MLB feature standard: cupom 1x per user (raro 2-3x).
    //   POST-FIX: query inclui max_uses_per_user, count check via idx
    //   composto idx_cuses_coupon_user (mig 085 pass 352) - O(log n).
    const c = await query(
      `SELECT id, code, discount_type, discount_value, tier_breakpoints,
              expires_at, min_tier, max_uses, max_uses_per_user, used_count, is_active
         FROM coupons
        WHERE UPPER(code) = UPPER($1) AND is_active
          AND (starts_at IS NULL OR starts_at <= NOW())
          AND (expires_at IS NULL OR expires_at > NOW())
          AND (max_uses IS NULL OR used_count < max_uses)`,
      [req.body.code]
    );
    if (!c.rows.length) return next(errorHandler.notFound('coupon_invalid'));

    // FIX-WORKER-14 pass 352: max_uses_per_user check (gap funcional descoberto)
    //   Defesa antes do tier check p/ early reject (UX + perf).
    //   COUNT exact com idx composto - cheap.
    const coupon = c.rows[0];
    if (coupon.max_uses_per_user && req.user?.sub) {
      const useCountRow = await query(
        `SELECT COUNT(*)::INT AS n FROM coupon_uses
          WHERE coupon_id = $1::UUID AND user_id = $2::UUID`,
        [coupon.id, req.user.sub]
      );
      const userUses = Number(useCountRow.rows[0]?.n || 0);
      if (userUses >= Number(coupon.max_uses_per_user)) {
        return res.status(403).json({
          error: 'coupon_max_uses_per_user_reached',
          message: `Voce ja utilizou este cupom ${userUses}x (limite: ${coupon.max_uses_per_user}).`,
          user_uses: userUses,
          max_uses_per_user: Number(coupon.max_uses_per_user),
        });
      }
    }

    // FIX-WORKER-16 MLB++: cupom segmentado por tier - check elegibilidade do user
    if (coupon.min_tier) {
      const userTierRow = await query(
        `SELECT tier FROM user_loyalty WHERE user_id = $1::UUID`, [req.user.sub]
      );
      const userTier = userTierRow.rows[0]?.tier || 'starter';
      const userRank = TIER_RANK[userTier] ?? 0;
      const minRank = TIER_RANK[coupon.min_tier] ?? 0;
      if (userRank < minRank) {
        return res.status(403).json({
          error: 'coupon_tier_insufficient',
          message: `Cupom exclusivo para tier ${coupon.min_tier}+. Seu tier atual: ${userTier}.`,
          required_tier: coupon.min_tier,
          your_tier: userTier,
        });
      }
    }

    // BUG 3 Regra K: tx() + SELECT FOR UPDATE em carts (anti-race /coupon vs /items)
    // FIX-WORKER-2 pass 681 (withRetry coupon apply deadlock defense)
    let cartId;
    await withRetry('cart.coupon.tx', async () => await tx(async (cli) => {
      const cartR = await cli.query(
        `SELECT id FROM carts WHERE user_id = $1::UUID FOR UPDATE`,
        [req.user.sub]
      );
      if (!cartR.rows.length) {
        // Cart nao existe - INSERT defensive (cria + aplica cupom atomico)
        const ins = await cli.query(
          `INSERT INTO carts (user_id, coupon_code) VALUES ($1::UUID, $2)
           ON CONFLICT (user_id) DO UPDATE SET coupon_code = EXCLUDED.coupon_code, updated_at = NOW()
           RETURNING id`,
          [req.user.sub, req.body.code]
        );
        cartId = ins.rows[0]?.id;
      } else {
        cartId = cartR.rows[0].id;
        await cli.query(
          `UPDATE carts SET coupon_code = $1, updated_at = NOW() WHERE id = $2::UUID`,
          [req.body.code, cartId]
        );
      }
      // recalcCart dentro do tx() - atomic + lock liberado em commit
      await recalcCart(cli, cartId);
    }));

    // BUG 4 Regra P: audit_log best-effort (nao bloqueia response success)
    query(
      `INSERT INTO audit_log
        (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
       VALUES ($1, $2, 'cart.coupon_applied', 'cart', $3, 'info', $4::JSONB)`,
      [req.user.sub, req.user.role || 'buyer', cartId,
       JSON.stringify({
         coupon_code: coupon.code,
         discount_type: coupon.discount_type,
         min_tier: coupon.min_tier || null,
         ip: req.ip,
       })]
    ).catch(() => { /* best-effort audit - log via global errorHandler chain */ });

    res.json({ ok: true, coupon });
  })
);

// MLB-4 redeem: POST /cart/loyalty/redeem - aplica pontos como desconto.
// Politica: 1 ponto = 1 cent (100pts = R$1). Min 500pts. Cap 30% subtotal. Atomico via tx.
router.post('/loyalty/redeem',
  validate({ body: z.object({ points: z.number().int().min(500).max(1000000) }) }),
  asyncHandler(async (req, res, next) => {
    // FIX-WORKER-16 pass 682 (withRetry loyalty redeem deadlock defense - CRITICAL real money)
    let result;
    await withRetry('cart.loyalty_redeem.tx', async () => await tx(async (c) => {
      // FIX-WORKER-7 pass 19 (RACE CONDITION CRITICAL):
      // PRE-FIX: SELECT points_balance SEM FOR UPDATE -> 2 requests simultaneas
      // viam mesmo balance, ambas validavam points<balance, ambas UPDATEs.
      // Cenario: user dispara 2 redeem 1000pts simultaneo. Balance=1500.
      // Ambos veem 1500, ambos passam validacao, mas UPDATE carts grava
      // apenas o ULTIMO valor (cart eh row unica por user). MAS usuario
      // espera 2000 pontos consumidos no checkout - so registra 1000.
      // Race tambem nas 2 queries SELECT (balance + cart) - ler stale entre elas.
      // FIX: FOR UPDATE em user_loyalty + carts (locks pessimistic)
      // - Inside tx() PG transacao - lock liberado apos COMMIT
      // - Segunda request bloqueia ate primeira terminar
      // - Mesmo pattern checkout (orders.js linha 31 + 49) consolidado
      const bal = await c.query(
        `SELECT points_balance FROM user_loyalty WHERE user_id = $1::UUID FOR UPDATE`,
        [req.user.sub]
      );
      const balance = parseInt(bal.rows[0]?.points_balance || 0, 10);
      if (req.body.points > balance) {
        result = { error: 'insufficient_points', balance };
        return;
      }
      // FIX-WORKER-7 pass 19: cart SELECT tambem com FOR UPDATE.
      // Previne race com /coupon, /items mutate, OU outra /loyalty/redeem.
      const cart = await c.query(
        `SELECT id, subtotal_cents FROM carts WHERE user_id = $1::UUID FOR UPDATE`,
        [req.user.sub]
      );
      if (!cart.rows.length) { result = { error: 'cart_not_found' }; return; }
      const subtotal = parseInt(cart.rows[0].subtotal_cents || 0, 10);
      if (subtotal < 500) { result = { error: 'cart_too_small', min_subtotal_cents: 500 }; return; }
      // cap 30% do subtotal
      const cap = Math.floor(subtotal * 0.30);
      const effectivePoints = Math.min(req.body.points, cap);
      // grava pendencia no cart (pontos NAO sao debitados ainda - apenas no checkout)
      // FIX 42P08: $1 usado em INT e BIGINT - cast explicito em ambas posicoes.
      await c.query(
        `UPDATE carts SET loyalty_points_redeemed = $1::INT, loyalty_discount_cents = $1::BIGINT
          WHERE id = $2::UUID`,
        [effectivePoints, cart.rows[0].id]
      );
      await recalcCart(c, cart.rows[0].id);
      result = { ok: true, applied_points: effectivePoints, discount_cents: effectivePoints, cap_cents: cap, balance };
    }));
    // FIX-WORKER-7 pass 19: error handling defensive fallback.
    // PRE-FIX: if result.error encadeados - novo error string futuro caia em
    // res.json(result) STATUS 200 com error field. Frontend confuso.
    // Pos-FIX: fallback final 500 para errors nao reconhecidos (anti-novel-error).
    if (result?.error) {
      if (result.error === 'insufficient_points') return res.status(400).json(result);
      if (result.error === 'cart_not_found') return next(errorHandler.notFound('cart_not_found'));
      if (result.error === 'cart_too_small') return res.status(400).json(result);
      // NOVO: fallback para errors futuros nao mapeados (defensive)
      return res.status(500).json({ error: 'loyalty_redeem_failed', detail: result.error });
    }
    res.json(result);
  })
);

// DELETE /cart/loyalty/redeem - remove resgate (libera pontos)
// FIX-WORKER-16 pass 683 (withRetry loyalty unredeem - COMPLETA order-svc 10/10 atomicity)
router.delete('/loyalty/redeem', asyncHandler(async (req, res) => {
  await withRetry('cart.loyalty_unredeem.tx', async () => await tx(async (c) => {
    const cart = await c.query(`SELECT id FROM carts WHERE user_id = $1::UUID`, [req.user.sub]);
    if (!cart.rows.length) return;
    await c.query(
      `UPDATE carts SET loyalty_points_redeemed = 0, loyalty_discount_cents = 0 WHERE id = $1::UUID`,
      [cart.rows[0].id]
    );
    await recalcCart(c, cart.rows[0].id);
  }));
  res.json({ ok: true });
}));

async function recalcCart(client, cart_id) {
  const items = await client.query(
    `SELECT SUM(line_total_cents) AS subtotal, COUNT(*) AS cnt FROM cart_items WHERE cart_id = $1`,
    [cart_id]
  );
  const subtotal = parseInt(items.rows[0].subtotal || 0, 10);
  const cnt = parseInt(items.rows[0].cnt, 10);
  const cart = await client.query(`SELECT coupon_code, loyalty_points_redeemed, loyalty_discount_cents FROM carts WHERE id = $1`, [cart_id]);
  let discount = 0;
  // MLB-4 redeem: loyalty discount sempre re-validado (cap 30% subtotal)
  let loyaltyPts = parseInt(cart.rows[0]?.loyalty_points_redeemed || 0, 10);
  let loyaltyCents = parseInt(cart.rows[0]?.loyalty_discount_cents || 0, 10);
  const loyaltyCap = Math.floor(subtotal * 0.30);
  if (loyaltyCents > loyaltyCap) {
    loyaltyCents = loyaltyCap;
    loyaltyPts = loyaltyCents; // 100pts = R$1 = 100 cents -> 1pt = 1 cent
  }
  if (cart.rows[0]?.coupon_code) {
    const co = await client.query(
      `SELECT discount_type, discount_value, tier_breakpoints FROM coupons WHERE code = $1 AND is_active`,
      [cart.rows[0].coupon_code]
    );
    if (co.rows.length) {
      // MLB-11: cupom progressivo - tier_breakpoints JSONB
      // formato: [{"min_cents":10000,"discount_value":5},{"min_cents":50000,"discount_value":10}]
      const tiers = co.rows[0].tier_breakpoints;
      let effectiveValue = parseFloat(co.rows[0].discount_value);
      if (Array.isArray(tiers) && tiers.length) {
        // ordena por min_cents asc e pega o maior tier que o subtotal alcanca
        const sorted = [...tiers].sort((a, b) => Number(a.min_cents) - Number(b.min_cents));
        for (const t of sorted) {
          if (subtotal >= Number(t.min_cents)) effectiveValue = parseFloat(t.discount_value);
        }
      }
      discount = co.rows[0].discount_type === 'percentage'
        ? Math.floor(subtotal * (effectiveValue / 100))
        : Math.floor(effectiveValue * 100);
    }
  }
  const total = Math.max(0, subtotal - discount - loyaltyCents);
  await client.query(
    `UPDATE carts SET items_count = $1::INT, subtotal_cents = $2::BIGINT, discount_cents = $3::BIGINT,
                       loyalty_points_redeemed = $4::INT, loyalty_discount_cents = $5::BIGINT,
                       total_cents = $6::BIGINT, updated_at = NOW()
     WHERE id = $7::UUID`,
    [cnt, subtotal, discount, loyaltyPts, loyaltyCents, total, cart_id]
  );
}

module.exports = router;
