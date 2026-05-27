'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShoppingCart, Loader2, Check, AlertCircle } from 'lucide-react';
import { Api } from '@/lib/api';
import { useAuth, useUI } from '@/lib/store';

// FIX-WORKER-3 pass 10 (DRY): friendlyCartError movido para lib/friendly-errors.ts
import { friendlyCartError } from '@/lib/friendly-errors';

/**
 * Botoes "Comprar agora" e "Adicionar ao carrinho" funcionais.
 * - Sem auth: redireciona para /login?next=...
 * - Com auth: POST /api/orders/cart/items + abre cart drawer
 */
export function AddToCart({ productId, isFree }: { productId: string; isFree?: boolean }) {
  const router = useRouter();
  const { token } = useAuth();
  const { setCartOpen } = useUI();
  const [loadingBuy, setLoadingBuy] = useState(false);
  const [loadingAdd, setLoadingAdd] = useState(false);
  const [added, setAdded] = useState(false);
  const [err, setErr] = useState('');

  function requireAuth() {
    if (!token) {
      window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
      return false;
    }
    return true;
  }

  async function addToCart() {
    if (!requireAuth()) return;
    setLoadingAdd(true); setErr('');
    try {
      await Api.api('/orders/cart/items', {
        method: 'POST', auth: token!,
        body: JSON.stringify({ product_id: productId, quantity: 1 }),
      });
      setAdded(true);
      setCartOpen(true); // abre drawer
      setTimeout(() => setAdded(false), 2000);
    } catch (e: any) {
      // FIX-WORKER-3 pass 2: replaces alert() raw com inline error message PT amigavel
      setErr(friendlyCartError(e));
      setTimeout(() => setErr(''), 5000);
    } finally { setLoadingAdd(false); }
  }

  async function buyNow() {
    if (!requireAuth()) return;
    setLoadingBuy(true); setErr('');
    try {
      await Api.api('/orders/cart/items', {
        method: 'POST', auth: token!,
        body: JSON.stringify({ product_id: productId, quantity: 1 }),
      });
      router.push('/checkout');
    } catch (e: any) {
      setErr(friendlyCartError(e));
      setTimeout(() => setErr(''), 5000);
      setLoadingBuy(false);
    }
  }

  if (isFree) {
    return (
      <>
        <button onClick={buyNow} disabled={loadingBuy} className="btn-primary w-full mb-3 text-base disabled:opacity-50">
          {loadingBuy ? <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> : null}
          Baixar gratis
        </button>
        {err && (
          <div role="alert" className="flex items-start gap-2 text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg p-2 mb-3">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" /> <span>{err}</span>
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <button onClick={buyNow} disabled={loadingBuy} className="btn-primary w-full mb-3 text-base disabled:opacity-50 flex items-center justify-center gap-2">
        {loadingBuy ? <><Loader2 className="w-4 h-4 animate-spin" /> Processando...</> : 'Comprar agora'}
      </button>
      <button onClick={addToCart} disabled={loadingAdd || added}
        className="btn-ghost w-full text-sm flex items-center justify-center gap-2 disabled:opacity-50">
        {loadingAdd ? <><Loader2 className="w-4 h-4 animate-spin" /> Adicionando...</> :
         added ?       <><Check className="w-4 h-4 text-green-400" /> Adicionado!</> :
                       <><ShoppingCart className="w-4 h-4" /> Adicionar ao carrinho</>}
      </button>
      {err && (
        <div role="alert" className="flex items-start gap-2 text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg p-2 mt-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" /> <span>{err}</span>
        </div>
      )}
    </>
  );
}
