'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Trash2, Tag } from 'lucide-react';
import { Api } from '@/lib/api';
import { useAuth } from '@/lib/store';

export default function CartPage() {
  const router = useRouter();
  const { token, user } = useAuth();
  const [cart, setCart] = useState<any>(null);
  const [coupon, setCoupon] = useState('');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  async function load() {
    if (!token) return;
    setLoading(true);
    try { const r = await Api.cart(token); setCart(r.cart); }
    catch (e: any) { setErr(e.message); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, [token]);

  async function remove(id: string) {
    await Api.cartDel(token!, id);
    load();
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
                  <div className="flex items-center justify-between mt-2">
                    <div className="text-sm text-white/70">Qtde: {it.quantity}</div>
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
