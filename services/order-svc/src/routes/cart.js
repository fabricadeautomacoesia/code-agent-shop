'use strict';

const express = require('express');
const { z } = require('zod');
const { query, tx } = require('@cas/db-client');
const { jwt, asyncHandler, validate, errorHandler } = require('@cas/shared');

const router = express.Router();
router.use(jwt.requireAuth());

// GET /orders/cart - carrinho atual do user
router.get('/', asyncHandler(async (req, res) => {
  await query(
    `INSERT INTO carts (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [req.user.sub]
  );
  const c = await query(
    `SELECT c.*,
      (SELECT json_agg(json_build_object(
         'id', ci.id, 'product_id', ci.product_id, 'quantity', ci.quantity,
         'unit_price_cents', ci.unit_price_cents, 'line_total_cents', ci.line_total_cents,
         'product', json_build_object(
           'title', p.title, 'slug', p.slug, 'cover_image_url', p.cover_image_url,
           'kind', p.kind, 'is_platform_owned', p.is_platform_owned,
           'seller_name', (SELECT store_name FROM sellers WHERE id = p.seller_id)
         )
       )) FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.cart_id = c.id) AS items
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
    const p = await query(
      `SELECT id, price_cents, currency, status, title FROM products WHERE id = $1`,
      [req.body.product_id]
    );
    if (!p.rows.length || !['approved','platform_owned'].includes(p.rows[0].status))
      return next(errorHandler.notFound('product_not_available'));

    const product = p.rows[0];
    const line_total = product.price_cents * req.body.quantity;

    await tx(async (c) => {
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
    });
    res.status(201).json({ ok: true });
  })
);

router.delete('/items/:id', asyncHandler(async (req, res) => {
  await tx(async (c) => {
    const r = await c.query(
      `DELETE FROM cart_items WHERE id = $1 AND cart_id IN (SELECT id FROM carts WHERE user_id = $2) RETURNING cart_id`,
      [req.params.id, req.user.sub]
    );
    if (r.rows.length) await recalcCart(c, r.rows[0].cart_id);
  });
  res.json({ ok: true });
}));

// FIX-WORKER-2: PATCH /cart/items/:id - atualiza quantidade absoluta + recalcula totals
// Antes nao existia: UI so removia item ou re-adicionava (sem +/-). Agora UI pode bumpar via 1 call.
router.patch('/items/:id',
  validate({ body: z.object({ quantity: z.number().int().min(1).max(99) }) }),
  asyncHandler(async (req, res, next) => {
    let cartId;
    await tx(async (c) => {
      // FIX: cart_items nao tem coluna updated_at (apenas created_at).
      // FIX: cast explicito INT para evitar PG 42P08 (bigint vs integer) quando $1 eh usado em
      // duas expressoes com tipos diferentes (quantity=int, line_total=bigint).
      const r = await c.query(
        `UPDATE cart_items SET
            quantity = $1::INT,
            line_total_cents = unit_price_cents * $1::INT
          WHERE id = $2::UUID AND cart_id IN (SELECT id FROM carts WHERE user_id = $3::UUID)
          RETURNING cart_id`,
        [req.body.quantity, req.params.id, req.user.sub]
      );
      if (!r.rows.length) return;
      cartId = r.rows[0].cart_id;
      await recalcCart(c, cartId);
    });
    if (!cartId) return next(errorHandler.notFound('cart_item_not_found'));
    res.json({ ok: true });
  })
);

// MLB-11: preview do cupom progressivo - retorna tiers ordenados e tier atual baseado em subtotal informado
// MLB++: tambem retorna min_tier do cupom + tier do user pra UI exibir badge 'Exclusivo Gold'
router.get('/coupon/:code/preview', asyncHandler(async (req, res, next) => {
  const subtotal = parseInt(req.query.subtotal_cents || '0', 10);
  const c = await query(
    `SELECT code, discount_type, discount_value, tier_breakpoints, expires_at, min_tier
       FROM coupons
      WHERE code = $1 AND is_active
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

router.post('/coupon',
  validate({ body: z.object({ code: z.string() }) }),
  asyncHandler(async (req, res, next) => {
    const c = await query(
      `SELECT * FROM coupons
        WHERE code = $1 AND is_active
          AND (starts_at IS NULL OR starts_at <= NOW())
          AND (expires_at IS NULL OR expires_at > NOW())
          AND (max_uses IS NULL OR used_count < max_uses)`,
      [req.body.code]
    );
    if (!c.rows.length) return next(errorHandler.notFound('coupon_invalid'));

    // FIX-WORKER-16 MLB++: cupom segmentado por tier - check elegibilidade do user
    const coupon = c.rows[0];
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

    await query(
      `UPDATE carts SET coupon_code = $1, updated_at = NOW() WHERE user_id = $2`,
      [req.body.code, req.user.sub]
    );
    const cart = await query('SELECT id FROM carts WHERE user_id = $1', [req.user.sub]);
    if (cart.rows.length) {
      await tx(async (cli) => { await recalcCart(cli, cart.rows[0].id); });
    }
    res.json({ ok: true, coupon });
  })
);

// MLB-4 redeem: POST /cart/loyalty/redeem - aplica pontos como desconto.
// Politica: 1 ponto = 1 cent (100pts = R$1). Min 500pts. Cap 30% subtotal. Atomico via tx.
router.post('/loyalty/redeem',
  validate({ body: z.object({ points: z.number().int().min(500).max(1000000) }) }),
  asyncHandler(async (req, res, next) => {
    let result;
    await tx(async (c) => {
      // saldo atual de pontos
      const bal = await c.query(`SELECT points_balance FROM user_loyalty WHERE user_id = $1::UUID`, [req.user.sub]);
      const balance = parseInt(bal.rows[0]?.points_balance || 0, 10);
      if (req.body.points > balance) {
        result = { error: 'insufficient_points', balance };
        return;
      }
      // subtotal atual do cart
      const cart = await c.query(`SELECT id, subtotal_cents FROM carts WHERE user_id = $1::UUID`, [req.user.sub]);
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
    });
    if (result.error) {
      if (result.error === 'insufficient_points') return res.status(400).json(result);
      if (result.error === 'cart_not_found') return next(errorHandler.notFound('cart_not_found'));
      if (result.error === 'cart_too_small') return res.status(400).json(result);
    }
    res.json(result);
  })
);

// DELETE /cart/loyalty/redeem - remove resgate (libera pontos)
router.delete('/loyalty/redeem', asyncHandler(async (req, res) => {
  await tx(async (c) => {
    const cart = await c.query(`SELECT id FROM carts WHERE user_id = $1::UUID`, [req.user.sub]);
    if (!cart.rows.length) return;
    await c.query(
      `UPDATE carts SET loyalty_points_redeemed = 0, loyalty_discount_cents = 0 WHERE id = $1::UUID`,
      [cart.rows[0].id]
    );
    await recalcCart(c, cart.rows[0].id);
  });
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
