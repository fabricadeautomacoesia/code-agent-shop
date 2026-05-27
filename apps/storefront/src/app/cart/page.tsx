'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Trash2, Tag, TrendingUp, Plus, Minus } from 'lucide-react';
import { Api } from '@/lib/api';
import { useAuth } from '@/lib/store';

export default function CartPage() {
  const router = useRouter();
  const { token, user } = useAuth();
  const [cart, setCart] = useState<any>(null);
  const [coupon, setCoupon] = useState('');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [couponPreview, setCouponPreview] = useState<any>(null);

  async function load() {
    if (!token) return;
    setLoading(true);
    try { const r = await Api.cart(token); setCart(r.cart); }
    catch (e: any) { setErr(e.message); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, [token]);

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
  async function applyCoupon(e: React.FormEvent) {
    e.preventDefault();
    try { await Api.cartCoupon(token!, coupon); load(); }
    catch (e: any) { setErr(e.message); }
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

  return (
    <div className="container mx-auto px-6 py-8">
      <h1 className="font-display font-bold text-4xl mb-8">Carrinho</h1>

      {loading ? (
        <div className="glass p-12 text-center text-white/60">Carregando...</div>
      ) : items.length === 0 ? (
        <div className="glass p-12 text-center">
          <p className="text-xl mb-4">Carrinho vazio</p>
          <Link href="/products" className="btn-primary inline-block">Explorar catalogo</Link>
        </div>
      ) : (
        <div className="grid lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-4">
            {items.map((it: any) => (
              <div key={it.id} className="glass p-4 flex gap-4">
                {it.product?.cover_image_url ? (
                  <img src={it.product.cover_image_url} alt={it.product.title} className="w-24 h-24 object-cover rounded-lg" />
                ) : (
                  <div className="w-24 h-24 bg-gradient-vibe/10 rounded-lg flex items-center justify-center font-bold">CAS</div>
                )}
                <div className="flex-1">
                  <div className="text-xs text-white/40 uppercase">{it.product?.kind?.replace(/_/g,' ')}</div>
                  <Link href={`/product/${it.product?.slug}`} className="font-display font-semibold text-lg hover:text-magenta">
                    {it.product?.title}
                  </Link>
                  <div className="text-sm text-white/60">{it.product?.seller_name}</div>
                  <div className="flex items-center justify-between mt-2 gap-2">
                    {/* FIX-WORKER-2: controles +/- de quantidade */}
                    <div className="inline-flex items-center rounded-lg border border-white/10 bg-white/5">
                      <button onClick={() => setQty(it.id, it.quantity - 1)}
                        aria-label="Diminuir quantidade"
                        className="p-1.5 hover:bg-white/10 rounded-l-lg transition-colors disabled:opacity-30"
                        disabled={it.quantity <= 1}>
                        <Minus className="w-3.5 h-3.5" />
                      </button>
                      <span className="px-3 text-sm font-mono font-semibold min-w-[32px] text-center">{it.quantity}</span>
                      <button onClick={() => setQty(it.id, it.quantity + 1)}
                        aria-label="Aumentar quantidade"
                        className="p-1.5 hover:bg-white/10 rounded-r-lg transition-colors disabled:opacity-30"
                        disabled={it.quantity >= 99}>
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="font-display font-bold text-magenta-glow">{Api.formatBRL(it.line_total_cents)}</div>
                  </div>
                </div>
                <button onClick={() => remove(it.id)} className="text-white/40 hover:text-red-400 p-2">
                  <Trash2 className="w-5 h-5" />
                </button>
              </div>
            ))}
          </div>

          <aside className="glass p-6 h-fit sticky top-28">
            <h3 className="font-display font-bold text-xl mb-4">Resumo</h3>

            <form onSubmit={applyCoupon} className="flex gap-2 mb-6">
              <input value={coupon} onChange={(e) => setCoupon(e.target.value)} placeholder="Cupom"
                className="flex-1 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm focus:border-magenta focus:outline-none" />
              <button className="px-3 py-2 rounded-lg glass text-sm">
                <Tag className="w-4 h-4" />
              </button>
            </form>

            <div className="space-y-2 text-sm border-b border-white/10 pb-4 mb-4">
              <div className="flex justify-between"><span className="text-white/60">Subtotal</span><span>{Api.formatBRL(cart?.subtotal_cents || 0)}</span></div>
              {cart?.discount_cents > 0 && (
                <div className="flex justify-between text-green-400"><span>Desconto {cart.coupon_code && `(${cart.coupon_code})`}</span><span>- {Api.formatBRL(cart.discount_cents)}</span></div>
              )}
            </div>

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

            <button onClick={() => router.push('/checkout')} className="btn-primary w-full text-base">
              Finalizar compra
            </button>
            {err && <div className="text-sm text-red-400 mt-3">{err}</div>}
          </aside>
        </div>
      )}
    </div>
  );
}
