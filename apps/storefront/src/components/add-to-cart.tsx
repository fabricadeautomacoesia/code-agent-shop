'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShoppingCart, Loader2, Check } from 'lucide-react';
import { Api } from '@/lib/api';
import { useAuth, useUI } from '@/lib/store';

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

  function requireAuth() {
    if (!token) {
      window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
      return false;
    }
    return true;
  }

  async function addToCart() {
    if (!requireAuth()) return;
    setLoadingAdd(true);
    try {
      await Api.api('/orders/cart/items', {
        method: 'POST', auth: token!,
        body: JSON.stringify({ product_id: productId, quantity: 1 }),
      });
      setAdded(true);
      setCartOpen(true); // abre drawer
      setTimeout(() => setAdded(false), 2000);
    } catch (e: any) {
      alert('Erro: ' + (e.data?.message || e.message));
    } finally { setLoadingAdd(false); }
  }

  async function buyNow() {
    if (!requireAuth()) return;
    setLoadingBuy(true);
    try {
      await Api.api('/orders/cart/items', {
        method: 'POST', auth: token!,
        body: JSON.stringify({ product_id: productId, quantity: 1 }),
      });
      router.push('/checkout');
    } catch (e: any) {
      alert('Erro: ' + (e.data?.message || e.message));
      setLoadingBuy(false);
    }
  }

  if (isFree) {
    return (
      <button onClick={buyNow} disabled={loadingBuy} className="btn-primary w-full mb-3 text-base disabled:opacity-50">
        {loadingBuy ? <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> : null}
        Baixar gratis
      </button>
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
    </>
  );
}
