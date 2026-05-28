'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { Trash2, Tag, TrendingUp, Plus, Minus, Star, ShoppingBag, AlertTriangle } from 'lucide-react';
import { Api } from '@/lib/api';
import { useAuth } from '@/lib/store';
import { ProgressiveCouponTeaser } from '@/components/progressive-coupon-teaser';

export default function CartPage() {
  const router = useRouter();
  const { token, user } = useAuth();
  const [cart, setCart] = useState<any>(null);
  const [coupon, setCoupon] = useState('');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [couponPreview, setCouponPreview] = useState<any>(null);
  const [loyalty, setLoyalty] = useState<any>(null);
  // FIX-WORKER-2 pass 249: redeem busy guard p/ anti-double-click race
  const [redeemBusy, setRedeemBusy] = useState(false);
  // FIX-WORKER-2 pass 255: coupon busy guard (mesma logica anti-double-click)
  const [couponBusy, setCouponBusy] = useState(false);

  async function load() {
    if (!token) return;
    setLoading(true);
    try { const r = await Api.cart(token); setCart(r.cart); }
    catch (e: any) { setErr(e.message); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, [token]);

  // MLB-4 redeem: fetch saldo de pontos
  useEffect(() => {
    if (!token) return;
    Api.api<any>('/loyalty/me', { auth: token, cache: 'no-store' })
      .then((r) => setLoyalty(r?.loyalty || null))
      .catch(() => {});
  }, [token, cart?.total_cents]);

  // FIX-WORKER-2 pass 249 (double-redeem race):
  //   PRE-FIX applyRedeem sem loading guard. POST /loyalty/redeem demora 200-500ms.
  //   User clica botao "Resgatar 100 pts" -> espera -> clica de novo durante delay
  //   -> 2 requests simultaneos -> double-decrement no points_balance.
  //   Backend tem idempotency partial (recalcCart re-soma), mas redeem usa
  //   subtract direto. Race resulta em pontos perdidos.
  //   POST-FIX: redeemBusy state + guard early-return.
  //   clearRedeem tambem ganha catch -> setErr (era silent swallow).
  async function applyRedeem(points: number) {
    if (!token || redeemBusy) return;
    setRedeemBusy(true);
    setErr('');
    try {
      await Api.cartLoyaltyRedeem(token, points);
      load();
    } catch (e: any) {
      setErr(e.data?.message || e.message || 'Erro ao resgatar pontos');
    } finally {
      setRedeemBusy(false);
    }
  }
  async function clearRedeem() {
    if (!token || redeemBusy) return;
    setRedeemBusy(true);
    setErr('');
    try {
      await Api.cartLoyaltyClear(token);
      load();
    } catch (e: any) {
      // FIX-WORKER-2 pass 249: era catch{} silent - user nao via erro
      setErr(e.data?.message || e.message || 'Erro ao remover pontos do carrinho');
    } finally {
      setRedeemBusy(false);
    }
  }

  // MLB-11: fetch progressive tiers preview quando ha cupom aplicado
  useEffect(() => {
    if (!cart?.coupon_code || !token) { setCouponPreview(null); return; }
    Api.api<any>(`/orders/cart/coupon/${cart.coupon_code}/preview?subtotal_cents=${cart.subtotal_cents}`, { auth: token, cache: 'no-store' })
      .then((r) => setCouponPreview(r))
      .catch(() => setCouponPreview(null));
  }, [cart?.coupon_code, cart?.subtotal_cents, token]);

  async function remove(id: string) {
    await Api.cartDel(token!, id);
    load();
  }

  // FIX-WORKER-2: alterar quantidade via PATCH com optimistic update
  async function setQty(id: string, qty: number) {
    if (qty < 1) return remove(id);
    if (qty > 99) return;
    // Optimistic UI: atualiza local antes da resposta
    setCart((c: any) => c ? ({
      ...c,
      items: c.items?.map((it: any) => it.id === id ? { ...it, quantity: qty, line_total_cents: it.unit_price_cents * qty } : it) || c.items,
    }) : c);
    try {
      await Api.cartSetQty(token!, id, qty);
      load(); // recarrega totals reais (subtotal/discount podem mudar com cupom progressivo)
    } catch (e: any) {
      setErr(e.message);
      load();
    }
  }
  // FIX-WORKER-2 pass 5: applyCoupon robustez
  // FIX-WORKER-2 pass 255: loading guard (paridade applyRedeem pass 249)
  //   Submit form 2x rapido -> 2 POST /cart/coupon em 200ms -> backend rate-limit
  //   30/hr/user consome 2 tokens. Race entre 2 POST pode race condition em
  //   carts.coupon_code (last write wins, mas audit_log gera 2 entries duplicados).
  //   POST-FIX: coupon busy state + early-return guard.
  async function applyCoupon(e: React.FormEvent) {
    e.preventDefault();
    if (couponBusy) return;
    setErr('');
    const code = coupon.trim().toUpperCase();
    if (!code) { setErr('Digite um codigo de cupom.'); return; }
    if (cart?.coupon_code === code) { setErr(`Cupom ${code} ja esta aplicado.`); return; }
    setCouponBusy(true);
    try {
      await Api.cartCoupon(token!, code);
      setCoupon(''); // limpa input apos aplicar OK
      load();
    } catch (e: any) {
      const msg = e.data?.message || e.message || '';
      // Friendly mapping para erros comuns do backend
      if (/not_found|inexistente|invalid/i.test(msg)) setErr(`Cupom ${code} nao encontrado ou expirado.`);
      else if (/min_tier|tier/i.test(msg)) setErr(`Cupom ${code} exclusivo para tier superior.`);
      else if (/expired/i.test(msg)) setErr(`Cupom ${code} expirou.`);
      else setErr(msg || `Erro ao aplicar cupom ${code}.`);
    } finally {
      setCouponBusy(false);
    }
  }

  if (!token) {
    return (
      <div className="container mx-auto px-6 py-16 max-w-lg text-center">
        <h1 className="font-display font-bold text-3xl mb-4">Faca login para ver seu carrinho</h1>
        <Link href="/login" className="btn-primary inline-block">Entrar</Link>
      </div>
    );
  }

  const items = cart?.items || [];

  // FIX-WORKER-11 pass 278: detecta items de sellers sem wallet configurada
  // (skip platform_owned - sao da CAS direta, nao precisam split).
  // Banner informativo: order eh aceito mas payout vai p/ debt queue
  // ate seller configurar wallet (cron 24h liquida). UX transparency.
  const noWalletItems = items.filter((it: any) =>
    it.product && !it.product.is_platform_owned && it.product.seller_wallet_configured === false
  );

  return (
    <div className="container mx-auto px-6 py-8">
      <h1 className="font-display font-bold text-4xl mb-8">Carrinho</h1>

      {loading ? (
        <div className="glass p-12 text-center text-white/60">Carregando...</div>
      ) : items.length === 0 ? (
        /* FIX-WORKER-8 pass 242 (visual parity): cart-drawer empty state ja tinha
           <ShoppingBag w-16 h-16> icon decorativo (linha 96-98 cart-drawer.tsx)
           mas /cart page empty state nao. Inconsistencia visual entre drawer
           e full-page renderings. POST-FIX: paridade adiciona icon + same
           padding pattern (espelha drawer empty state) + aria-hidden decorativo. */
        <div className="glass p-12 text-center">
          <ShoppingBag className="w-16 h-16 mx-auto mb-4 text-white/20" aria-hidden="true" />
          <p className="text-xl mb-4">Carrinho vazio</p>
          <Link href="/products" className="btn-primary inline-block">Explorar catalogo</Link>
        </div>
      ) : (
        <>
        {/* FIX-WORKER-11 pass 278: wallet warning banner (pre-checkout)
            Quando >=1 item tem seller sem asaas_wallet_id, informa buyer
            de forma transparente que esses payouts entram debt queue.
            Order eh processado normal - apenas a liquidacao p/ seller
            tem delay (cron 24h apos seller configurar wallet). */}
        {noWalletItems.length > 0 && (
          <div role="alert" className="glass border border-orange-500/30 bg-orange-500/5 p-4 mb-6 flex gap-3 items-start">
            <AlertTriangle className="w-5 h-5 text-orange-300 flex-shrink-0 mt-0.5" aria-hidden="true" />
            <div className="text-sm">
              <div className="font-semibold text-orange-200 mb-1">
                {noWalletItems.length === 1 ? '1 produto' : `${noWalletItems.length} produtos`} de vendedor sem carteira configurada
              </div>
              <p className="text-white/70 text-xs leading-relaxed">
                Sua compra sera processada normalmente, mas o repasse ao vendedor sera feito apos ele
                configurar a carteira Asaas. Voce nao paga nada a mais por isso. Itens afetados:
                {' '}
                <span className="text-white/90">
                  {noWalletItems.map((it: any) => it.product?.title).filter(Boolean).join(', ')}
                </span>
              </p>
            </div>
          </div>
        )}
        <div className="grid lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-4">
            {items.map((it: any) => (
              <div key={it.id} className="glass p-4 flex gap-4">
                {/* FIX-WORKER-8: <img> -> next/image (perf + a11y) */}
                {it.product?.cover_image_url ? (
                  <div className="w-24 h-24 relative rounded-lg overflow-hidden flex-shrink-0">
                    <Image src={it.product.cover_image_url} alt={it.product.title || 'Produto'}
                      fill sizes="96px" className="object-cover" />
                  </div>
                ) : (
                  <div className="w-24 h-24 bg-gradient-vibe/10 rounded-lg flex items-center justify-center font-bold flex-shrink-0">CAS</div>
                )}
                <div className="flex-1">
                  <div className="text-xs text-white/40 uppercase">{it.product?.kind?.replace(/_/g,' ')}</div>
                  <Link href={`/product/${it.product?.slug}`} className="font-display font-semibold text-lg hover:text-magenta">
                    {it.product?.title}
                  </Link>
                  <div className="text-sm text-white/60">{it.product?.seller_name}</div>
                  <div className="flex items-center justify-between mt-2 gap-2">
                    {/* FIX-WORKER-2: controles +/- de quantidade */}
                    {/* FIX-WORKER-2 pass 161 (a11y): type='button' + aria-label dinamico + aria-live qty */}
                    <div className="inline-flex items-center rounded-lg border border-white/10 bg-white/5">
                      <button type="button" onClick={() => setQty(it.id, it.quantity - 1)}
                        aria-label={`Diminuir quantidade de ${it.product?.title || 'produto'} (atual: ${it.quantity})`}
                        className="p-1.5 hover:bg-white/10 rounded-l-lg transition-colors disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-magenta"
                        disabled={it.quantity <= 1}>
                        <Minus className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>
                      <span aria-live="polite" className="px-3 text-sm font-mono font-semibold min-w-[32px] text-center">{it.quantity}</span>
                      <button type="button" onClick={() => setQty(it.id, it.quantity + 1)}
                        aria-label={`Aumentar quantidade de ${it.product?.title || 'produto'} (atual: ${it.quantity})`}
                        className="p-1.5 hover:bg-white/10 rounded-r-lg transition-colors disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-magenta"
                        disabled={it.quantity >= 99}>
                        <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>
                    </div>
                    <div className="font-display font-bold text-magenta-glow">{Api.formatBRL(it.line_total_cents)}</div>
                  </div>
                </div>
                <button type="button" onClick={() => remove(it.id)}
                  aria-label={`Remover ${it.product?.title || 'produto'} do carrinho`}
                  className="text-white/40 hover:text-red-400 p-2 focus-visible:outline-2 focus-visible:outline-red-400 rounded">
                  <Trash2 className="w-5 h-5" aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>

          <aside className="glass p-6 h-fit sticky top-28">
            <h3 className="font-display font-bold text-xl mb-4">Resumo</h3>

            {/* FIX-WORKER-2 pass 5: form cupom acessivel + estados visuais
                - disabled quando vazio (impede submit sem codigo)
                - aria-label no botao icone-only
                - hover state visivel (border-magenta)
                - uppercase auto no input (cupons sao case-insensitive no backend, mas
                  visual consistente: "progressivo15" vira "PROGRESSIVO15") */}
            <form onSubmit={applyCoupon} className="flex gap-2 mb-4">
              <input value={coupon}
                onChange={(e) => setCoupon(e.target.value)}
                placeholder="Cupom (ex: PROGRESSIVO15)"
                aria-label="Codigo do cupom"
                style={{ textTransform: 'uppercase' }}
                className="flex-1 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm focus:border-magenta focus:outline-none placeholder:normal-case placeholder:text-white/40" />
              <button type="submit"
                disabled={!coupon.trim() || couponBusy}
                aria-label={couponBusy ? 'Aplicando cupom' : 'Aplicar cupom'}
                aria-busy={couponBusy}
                title="Aplicar cupom"
                className="px-3 py-2 rounded-lg glass text-sm hover:border-magenta transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-white/10">
                <Tag className="w-4 h-4" aria-hidden="true" />
              </button>
            </form>

            {/* MLB-NEW WORKER 16: cupom progressivo proativo (skip se ja ha cupom aplicado) */}
            <ProgressiveCouponTeaser
              token={token}
              subtotalCents={cart?.subtotal_cents || 0}
              alreadyApplied={!!cart?.coupon_code}
              onApplied={load}
            />

            <div className="space-y-2 text-sm border-b border-white/10 pb-4 mb-4">
              <div className="flex justify-between"><span className="text-white/60">Subtotal</span><span>{Api.formatBRL(cart?.subtotal_cents || 0)}</span></div>
              {cart?.discount_cents > 0 && (
                <div className="flex justify-between text-green-400"><span>Desconto {cart.coupon_code && `(${cart.coupon_code})`}</span><span>- {Api.formatBRL(cart.discount_cents)}</span></div>
              )}
              {cart?.loyalty_discount_cents > 0 && (
                <div className="flex justify-between text-magenta-glow">
                  <span className="flex items-center gap-1"><Star className="w-3 h-3" aria-hidden="true" /> {cart.loyalty_points_redeemed} pts</span>
                  <span>- {Api.formatBRL(cart.loyalty_discount_cents)}</span>
                </div>
              )}
            </div>

            {/* MLB-4 Loyalty Redeem card */}
            {loyalty && Number(loyalty.points_balance) >= 500 && (
              <div className="rounded-lg border border-magenta/30 bg-magenta/5 p-3 mb-4">
                <div className="flex items-center gap-2 text-xs font-bold text-magenta mb-2">
                  <Star className="w-3.5 h-3.5" aria-hidden="true" /> CAS PONTOS
                </div>
                <div className="text-[11px] text-white/60 mb-2">
                  Saldo: <strong className="text-white">{Number(loyalty.points_balance).toLocaleString('pt-BR')}</strong> pts
                  - 100pts = R$1 - max 30% do subtotal
                </div>
                {cart?.loyalty_points_redeemed > 0 ? (
                  <div className="flex items-center justify-between">
                    <div className="text-xs text-magenta-glow">
                      {cart.loyalty_points_redeemed} pts aplicados
                    </div>
                    {/* FIX-WORKER-2 pass 161 (a11y): type='button' + aria-label */}
                    <button type="button" onClick={clearRedeem}
                      disabled={redeemBusy}
                      aria-label="Remover pontos de fidelidade aplicados"
                      className="text-[11px] text-white/60 hover:text-white underline focus-visible:outline-2 focus-visible:outline-magenta rounded disabled:opacity-50 disabled:cursor-wait">
                      Remover
                    </button>
                  </div>
                ) : (
                  <div className="flex gap-1.5">
                    {[500, 1000, 5000].filter((p) => p <= Number(loyalty.points_balance)).map((p) => (
                      <button type="button" key={p} onClick={() => applyRedeem(p)}
                        disabled={redeemBusy}
                        aria-label={`Aplicar ${p} pontos (desconto ${Api.formatBRL(p)})`}
                        className="flex-1 px-2 py-1.5 rounded text-[11px] bg-white/5 hover:bg-magenta/20 border border-white/10 hover:border-magenta/50 transition-colors focus-visible:outline-2 focus-visible:outline-magenta disabled:opacity-50 disabled:cursor-wait">
                        {p}pts<br /><span className="text-magenta-glow">-{Api.formatBRL(p)}</span>
                      </button>
                    ))}
                    {Number(loyalty.points_balance) > 5000 && (
                      <button type="button" onClick={() => applyRedeem(Number(loyalty.points_balance))}
                        aria-label={`Aplicar maximo ${Number(loyalty.points_balance)} pontos disponiveis`}
                        className="flex-1 px-2 py-1.5 rounded text-[11px] bg-white/5 hover:bg-magenta/20 border border-white/10 hover:border-magenta/50 transition-colors focus-visible:outline-2 focus-visible:outline-magenta">
                        Max<br /><span className="text-magenta-glow">{Number(loyalty.points_balance)}pts</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* MLB++ WORKER 16: Cupom tier-segmentado - badge exclusivo */}
            {couponPreview?.coupon?.min_tier && (
              <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/5 p-2.5 mb-3 flex items-center gap-2">
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-300 font-bold uppercase tracking-wider">
                  Exclusivo {couponPreview.coupon.min_tier}
                </span>
                <span className="text-[11px] text-white/60">
                  Cupom para tier <strong className="text-yellow-300">{couponPreview.coupon.min_tier}+</strong>
                  {couponPreview.user_tier && ` (seu: ${couponPreview.user_tier})`}
                </span>
              </div>
            )}

            {/* MLB-11: Cupom progressivo - tiers visuais */}
            {couponPreview?.tiers?.length > 0 && (
              <div className="rounded-lg border border-magenta/30 bg-magenta/5 p-3 mb-4">
                <div className="flex items-center gap-2 text-xs font-bold text-magenta mb-2">
                  <TrendingUp className="w-3.5 h-3.5" />
                  CUPOM PROGRESSIVO {cart.coupon_code}
                </div>
                <div className="space-y-1.5">
                  {couponPreview.tiers.map((t: any, idx: number) => {
                    const reached = (cart.subtotal_cents || 0) >= Number(t.min_cents);
                    const isActive = idx === couponPreview.active_tier_index;
                    return (
                      <div key={idx} className={`flex justify-between text-xs ${isActive ? 'text-white font-bold' : reached ? 'text-white/70' : 'text-white/40'}`}>
                        <span>
                          {reached ? '+' : 'o'} A partir de {Api.formatBRL(Number(t.min_cents))}
                        </span>
                        <span className={isActive ? 'text-magenta-glow' : ''}>
                          -{t.discount_value}{couponPreview.coupon?.discount_type === 'percentage' ? '%' : ' R$'}
                        </span>
                      </div>
                    );
                  })}
                </div>
                {couponPreview.next_tier && (
                  <div className="text-[11px] text-white/50 mt-2 pt-2 border-t border-white/10">
                    Adicione mais <strong className="text-white">{Api.formatBRL(Number(couponPreview.next_tier.min_cents) - (cart.subtotal_cents || 0))}</strong> para -{couponPreview.next_tier.discount_value}{couponPreview.coupon?.discount_type === 'percentage' ? '%' : ' R$'} de desconto
                  </div>
                )}
              </div>
            )}

            <div className="flex justify-between text-xl font-display font-bold mb-6">
              <span>Total</span>
              <span className="text-magenta-glow">{Api.formatBRL(cart?.total_cents || 0)}</span>
            </div>

            <button type="button" onClick={() => router.push('/checkout')}
              aria-label="Ir para checkout"
              className="btn-primary w-full text-base focus-visible:outline-2 focus-visible:outline-magenta">
              Finalizar compra
            </button>
            {err && <div className="text-sm text-red-400 mt-3">{err}</div>}
          </aside>
        </div>
        </>
      )}
    </div>
  );
}
