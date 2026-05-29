'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { X, Trash2, ShoppingBag, ArrowRight, Plus, Minus, Star } from 'lucide-react';
import { Api } from '@/lib/api';
import { useAuth, useUI } from '@/lib/store';
import { Dialog } from './dialog';

/**
 * Cart drawer lateral. Abre via setCartOpen(true) de qualquer lugar.
 * Recarrega cart sempre que abre.
 *
 * FIX-WORKER-3 pass 10: REFATORADO para usar <Dialog> wrapper (pass 9).
 * Remove duplicacao 7 elementos pattern dialog modal (Escape, body lock,
 * role=dialog, aria-modal, aria-labelledby, backdrop semantico, focus mgmt).
 * Pre-fix: ~30 linhas codigo wrapping + 2 useEffect distintos.
 * Pos-fix: 1 componente Dialog declarativo. Manutencao centralizada.
 * Bonus pass 9: focus auto-mount + return-to-opener (a11y melhor que pre-fix).
 */
export function CartDrawer() {
  const { token } = useAuth();
  const { cartOpen, setCartOpen } = useUI();
  const [cart, setCart] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  /* FIX-WORKER-15 pass 501 (paridade pass 494 cart page mutations):
     PRE-FIX BUG (3 issues simetricos ao /cart page pre-pass-494):
     1. removeItem(): await sem try/catch -> unhandled rejection silent
        - Sem busy guard: 2 cliques < 16ms = 2 DELETE concorrentes
        - Sem error feedback: user clica X icon, nada acontece, silent fail
     2. setQty(): try { ... } catch {} silent swallow
        - Optimistic update flippa, mas backend nao confirma -> stale state
        - User altera qty no drawer, cart real nao muda, sem feedback
     3. CartDrawer mobile 375px: price div pode overflow se Total R$50k+
        (10+ char text-sm + qty group 3 buttons em flex-row gap-2)
     POST-FIX (paridade pass 494):
     - removingId state per-item (granular vs global busy)
     - try/catch + setErr + load() em finally (sync backend)
     - setQty: error feedback explicit + load() em catch tambem
     - Bonus mobile: min-w-0 + truncate em price div (overflow defesa) */
  const [err, setErr] = useState('');
  const [removingId, setRemovingId] = useState<string | null>(null);

  async function load() {
    if (!token) { setCart(null); return; }
    setLoading(true);
    try { const r = await Api.cart(token); setCart(r.cart); }
    catch { /* ignore */ }
    finally { setLoading(false); }
  }
  useEffect(() => { if (cartOpen) load(); }, [cartOpen, token]);

  // FIX-WORKER-3 pass 10: useEffect manual REMOVIDO - <Dialog> wrapper
  // agora gerencia Escape close + body scroll lock + focus management.

  async function removeItem(id: string) {
    if (!token || removingId) return;
    setRemovingId(id);
    setErr('');
    try {
      await Api.cartDel(token, id);
    } catch (e: any) {
      setErr(e?.data?.message || e?.message || 'Erro ao remover item');
    } finally {
      setRemovingId(null);
      load();
    }
  }

  // FIX-WORKER-15: paridade com /cart - mudar quantidade direto no drawer
  async function setQty(id: string, qty: number) {
    if (!token) return;
    if (qty < 1) return removeItem(id);
    if (qty > 99) return;
    setErr('');
    // optimistic local + reload
    setCart((c: any) => c ? ({
      ...c,
      items: c.items?.map((it: any) => it.id === id ? { ...it, quantity: qty, line_total_cents: it.unit_price_cents * qty } : it) || c.items,
    }) : c);
    try {
      await Api.cartSetQty(token, id, qty);
      load();
    } catch (e: any) {
      // FIX pass 501 (silent swallow -> explicit error + rollback via load)
      setErr(e?.data?.message || e?.message || 'Erro ao atualizar quantidade');
      load(); // rollback optimistic via authoritative state
    }
  }

  const items = cart?.items || [];

  // FIX-WORKER-3 pass 10: <Dialog> wrapper handles open/close lifecycle.
  // hideCloseButton=true porque CartDrawer tem header custom (ShoppingBag icon +
  // X manual posicionado dentro do header). className override para drawer-right
  // h-full p/ manter visual identico ao pre-refactor.
  return (
    <Dialog
      open={cartOpen}
      onClose={() => setCartOpen(false)}
      title="Carrinho"
      ariaLabel="Carrinho de compras"
      variant="drawer-right"
      closeLabel="Fechar carrinho"
      hideCloseButton
      className="relative w-full max-w-md glass-strong h-full flex flex-col rounded-none border-l border-white/10"
    >
      <header className="flex items-center justify-between p-5 border-b border-white/10">
        <h2 className="font-display font-bold text-xl flex items-center gap-2">
          <ShoppingBag className="w-5 h-5 text-magenta" aria-hidden="true" /> Carrinho
        </h2>
        {/* FIX-WORKER-1 pass 157 (a11y defensive): type='button' explicit em 4 botoes UI */}
        <button type="button" onClick={() => setCartOpen(false)}
          aria-label="Fechar carrinho"
          className="p-2 hover:bg-white/5 rounded-lg focus-visible:outline-2 focus-visible:outline-magenta">
          <X className="w-5 h-5" aria-hidden="true" />
        </button>
      </header>

        <div className="flex-1 overflow-y-auto p-5">
          {/* FIX pass 501 (a11y paridade pass 457 cart + pass 492 auth):
              error banner com role=alert + aria-live + dismiss button focus-visible */}
          {err && (
            <div role="alert" aria-live="assertive"
              className="text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg p-3 mb-3 flex items-start justify-between gap-2">
              <span className="flex-1">{err}</span>
              <button type="button" onClick={() => setErr('')}
                aria-label="Fechar mensagem de erro"
                className="text-xs hover:underline focus-visible:outline-2 focus-visible:outline-red-400 rounded">fechar</button>
            </div>
          )}
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
                        {/* FIX-WORKER-15 pass 157 (a11y): aria-label dinamico com produto + qty atual */}
                        <button type="button" onClick={(e) => { e.preventDefault(); setQty(it.id, it.quantity - 1); }}
                          aria-label={`Diminuir quantidade de ${it.product?.title || 'produto'} (atual: ${it.quantity})`}
                          className="p-1 hover:bg-white/10 rounded-l disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-magenta"
                          disabled={it.quantity <= 1}>
                          <Minus className="w-3 h-3" aria-hidden="true" />
                        </button>
                        <span aria-live="polite" className="px-2 text-xs font-mono font-semibold min-w-[24px] text-center">{it.quantity}</span>
                        <button type="button" onClick={(e) => { e.preventDefault(); setQty(it.id, it.quantity + 1); }}
                          aria-label={`Aumentar quantidade de ${it.product?.title || 'produto'} (atual: ${it.quantity})`}
                          className="p-1 hover:bg-white/10 rounded-r disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-magenta"
                          disabled={it.quantity >= 99}>
                          <Plus className="w-3 h-3" aria-hidden="true" />
                        </button>
                      </div>
                      {/* FIX pass 501: min-w-0 + truncate p/ totals R$50k+ em 375px (overflow defesa) */}
                      <div className="font-display font-bold text-sm text-magenta-glow min-w-0 truncate" title={Api.formatBRL(it.line_total_cents)}>{Api.formatBRL(it.line_total_cents)}</div>
                    </div>
                  </div>
                  {/* FIX-WORKER-1 pass 157 (a11y): aria-label dinamico + type='button'
                      FIX pass 501: disabled + aria-busy + cursor-wait paridade /cart page */}
                  <button type="button" onClick={() => removeItem(it.id)}
                    disabled={removingId === it.id}
                    aria-busy={removingId === it.id}
                    aria-label={`Remover ${it.product?.title || 'produto'} do carrinho`}
                    className="text-white/40 hover:text-red-400 p-1 h-fit focus-visible:outline-2 focus-visible:outline-red-400 rounded disabled:opacity-50 disabled:cursor-wait">
                    <Trash2 className="w-4 h-4" aria-hidden="true" />
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
                    <Star className="w-3 h-3" aria-hidden="true" /> {cart.loyalty_points_redeemed} pts
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
    </Dialog>
  );
}
