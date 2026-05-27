'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { X, Trash2, ShoppingBag, ArrowRight, Plus, Minus, Star } from 'lucide-react';
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

  // FIX-WORKER-3 pass 8 (a11y Escape close): keyboard users sem mouse precisam
  // sair do drawer. Pattern aplicado NotificationBell pass 7. WCAG 2.1.1.
  useEffect(() => {
    if (!cartOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCartOpen(false); };
    window.addEventListener('keydown', onKey);
    // FIX-WORKER-3 pass 8 (UX): lock body scroll quando drawer aberto (era
    // possivel scrollar page por baixo). Reset on cleanup.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [cartOpen, setCartOpen]);

  async function removeItem(id: string) {
    if (!token) return;
    await Api.cartDel(token, id);
    load();
  }

  // FIX-WORKER-15: paridade com /cart - mudar quantidade direto no drawer
  async function setQty(id: string, qty: number) {
    if (!token) return;
    if (qty < 1) return removeItem(id);
    if (qty > 99) return;
    // optimistic local + reload
    setCart((c: any) => c ? ({
      ...c,
      items: c.items?.map((it: any) => it.id === id ? { ...it, quantity: qty, line_total_cents: it.unit_price_cents * qty } : it) || c.items,
    }) : c);
    try { await Api.cartSetQty(token, id, qty); load(); } catch {}
  }

  if (!cartOpen) return null;
  const items = cart?.items || [];

  return (
    // FIX-WORKER-3 pass 8 (a11y): outer div era click=close mas sem semantica.
    // Agora wrapper passivo (sem role). Backdrop INNER recebe role=button para
    // a11y (click close = action explicita). Aside vira role=dialog real.
    <div className="fixed inset-0 z-[60] flex justify-end">
      {/* Backdrop click = close. role=button + aria-label para screen readers
          (era invisivel a11y). aria-hidden=false porque eh interativo. */}
      <button type="button"
        aria-label="Fechar carrinho"
        onClick={() => setCartOpen(false)}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm cursor-default" />
      {/* FIX-WORKER-3 pass 8 (a11y): role=dialog + aria-modal + aria-labelledby
          permite screen readers anunciar "Carrinho dialog modal" + focus trap natural */}
      <aside role="dialog"
        aria-modal="true"
        aria-labelledby="cart-drawer-title"
        className="relative w-full max-w-md glass-strong h-full flex flex-col rounded-none border-l border-white/10">
        <header className="flex items-center justify-between p-5 border-b border-white/10">
          <h2 id="cart-drawer-title" className="font-display font-bold text-xl flex items-center gap-2">
            <ShoppingBag className="w-5 h-5 text-magenta" aria-hidden="true" /> Carrinho
          </h2>
          <button onClick={() => setCartOpen(false)}
            aria-label="Fechar carrinho"
            className="p-2 hover:bg-white/5 rounded-lg focus-visible:outline-2 focus-visible:outline-magenta">
            <X className="w-5 h-5" aria-hidden="true" />
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
                  {/* FIX-WORKER-8: <img> -> next/image (perf + a11y). Antes carregava
                      imagem fullsize do CDN para renderizar em 64px + alt vazio em conteudo. */}
                  {it.product?.cover_image_url ? (
                    <div className="w-16 h-16 relative rounded overflow-hidden flex-shrink-0">
                      {/* FIX-WORKER-18 pass 4: loading="lazy" - drawer offscreen ate setCartOpen(true).
                          Sem lazy: thumbs carregavam imediatamente no mount mesmo invisivel. */}
                      <Image src={it.product.cover_image_url} alt={it.product.title || 'Produto'}
                        fill sizes="64px" loading="lazy" className="object-cover" />
                    </div>
                  ) : (
                    <div className="w-16 h-16 bg-gradient-vibe/20 rounded flex items-center justify-center text-xs font-bold flex-shrink-0">CAS</div>
                  )}
                  <div className="flex-1 min-w-0">
                    <Link href={`/product/${it.product?.slug}`} onClick={() => setCartOpen(false)}
                      className="text-sm font-semibold line-clamp-2 hover:text-magenta">
                      {it.product?.title}
                    </Link>
                    {/* FIX-WORKER-15: controles +/- inline (paridade com /cart) */}
                    <div className="flex items-center justify-between mt-2 gap-2">
                      <div className="inline-flex items-center rounded border border-white/10 bg-white/5">
                        <button onClick={(e) => { e.preventDefault(); setQty(it.id, it.quantity - 1); }}
                          aria-label="Diminuir"
                          className="p-1 hover:bg-white/10 rounded-l disabled:opacity-30"
                          disabled={it.quantity <= 1}>
                          <Minus className="w-3 h-3" />
                        </button>
                        <span className="px-2 text-xs font-mono font-semibold min-w-[24px] text-center">{it.quantity}</span>
                        <button onClick={(e) => { e.preventDefault(); setQty(it.id, it.quantity + 1); }}
                          aria-label="Aumentar"
                          className="p-1 hover:bg-white/10 rounded-r disabled:opacity-30"
                          disabled={it.quantity >= 99}>
                          <Plus className="w-3 h-3" />
                        </button>
                      </div>
                      <div className="font-display font-bold text-sm text-magenta-glow">{Api.formatBRL(it.line_total_cents)}</div>
                    </div>
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
                <div className="flex justify-between text-green-400">
                  <span>{cart.coupon_code ? `Cupom (${cart.coupon_code})` : 'Desconto'}</span>
                  <span>- {Api.formatBRL(cart.discount_cents)}</span>
                </div>
              )}
              {/* FIX-WORKER-15: linha de loyalty discount (paridade com /cart) */}
              {cart.loyalty_discount_cents > 0 && (
                <div className="flex justify-between text-magenta-glow">
                  <span className="flex items-center gap-1">
                    <Star className="w-3 h-3" /> {cart.loyalty_points_redeemed} pts
                  </span>
                  <span>- {Api.formatBRL(cart.loyalty_discount_cents)}</span>
                </div>
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
