'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { X, Trash2, ShoppingBag, ArrowRight } from 'lucide-react';
import { Api } from '@/lib/api';
import { useAuth, useUI } from '@/lib/store';

/**
 * Cart drawer lateral. Abre via setCartOpen(true) de qualquer lugar.
 * Recarrega cart sempre que abre.
 */
export function CartDrawer() {
  const { token } = useAuth();
  const { cartOpen, setCartOpen } = useUI();
  const [cart, setCart] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    if (!token) { setCart(null); return; }
    setLoading(true);
    try { const r = await Api.cart(token); setCart(r.cart); }
    catch { /* ignore */ }
    finally { setLoading(false); }
  }
  useEffect(() => { if (cartOpen) load(); }, [cartOpen, token]);

  async function removeItem(id: string) {
    if (!token) return;
    await Api.cartDel(token, id);
    load();
  }

  if (!cartOpen) return null;
  const items = cart?.items || [];

  return (
    <div className="fixed inset-0 z-[60] flex justify-end" onClick={() => setCartOpen(false)}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <aside className="relative w-full max-w-md glass-strong h-full flex flex-col rounded-none border-l border-white/10"
        onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between p-5 border-b border-white/10">
          <h2 className="font-display font-bold text-xl flex items-center gap-2">
            <ShoppingBag className="w-5 h-5 text-magenta" /> Carrinho
          </h2>
          <button onClick={() => setCartOpen(false)} className="p-2 hover:bg-white/5 rounded-lg">
            <X className="w-5 h-5" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5">
          {!token ? (
            <div className="text-center py-12">
              <p className="text-white/60 mb-4">Faca login para ver seu carrinho</p>
              <Link href="/login" onClick={() => setCartOpen(false)} className="btn-primary inline-block">Entrar</Link>
            </div>
          ) : loading ? (
            <div className="text-center py-12 text-white/60">Carregando...</div>
          ) : items.length === 0 ? (
            <div className="text-center py-12">
              <ShoppingBag className="w-16 h-16 mx-auto mb-4 text-white/20" />
              <p className="text-white/60 mb-4">Carrinho vazio</p>
              <Link href="/products" onClick={() => setCartOpen(false)} className="btn-primary inline-flex items-center gap-2">
                Explorar catalogo <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          ) : (
            <div className="space-y-3">
              {items.map((it: any) => (
                <div key={it.id} className="flex gap-3 p-3 rounded-lg bg-white/5">
                  {it.product?.cover_image_url ? (
                    <img src={it.product.cover_image_url} alt="" className="w-16 h-16 object-cover rounded" />
                  ) : (
                    <div className="w-16 h-16 bg-gradient-vibe/20 rounded flex items-center justify-center text-xs font-bold">CAS</div>
                  )}
                  <div className="flex-1 min-w-0">
                    <Link href={`/product/${it.product?.slug}`} onClick={() => setCartOpen(false)}
                      className="text-sm font-semibold line-clamp-2 hover:text-magenta">
                      {it.product?.title}
                    </Link>
                    <div className="text-xs text-white/50 mt-1">Qtde: {it.quantity}</div>
                    <div className="font-display font-bold text-magenta-glow mt-1">{Api.formatBRL(it.line_total_cents)}</div>
                  </div>
                  <button onClick={() => removeItem(it.id)} className="text-white/40 hover:text-red-400 p-1 h-fit">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {token && items.length > 0 && (
          <footer className="border-t border-white/10 p-5 space-y-3">
            <div className="space-y-1 text-sm">
              <div className="flex justify-between text-white/60"><span>Subtotal</span><span>{Api.formatBRL(cart.subtotal_cents)}</span></div>
              {cart.discount_cents > 0 && (
                <div className="flex justify-between text-green-400"><span>Desconto</span><span>- {Api.formatBRL(cart.discount_cents)}</span></div>
              )}
              <div className="flex justify-between text-lg font-display font-bold pt-2 border-t border-white/10">
                <span>Total</span>
                <span className="text-magenta-glow">{Api.formatBRL(cart.total_cents)}</span>
              </div>
            </div>
            <Link href="/checkout" onClick={() => setCartOpen(false)} className="btn-primary w-full text-center text-base block">
              Finalizar compra
            </Link>
            <Link href="/cart" onClick={() => setCartOpen(false)} className="text-xs text-center block text-white/50 hover:text-white">
              Ver carrinho completo
            </Link>
          </footer>
        )}
      </aside>
    </div>
  );
}
