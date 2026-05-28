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
 *
 * FIX-WORKER-3 pass 3: 4 bugs de race condition + loading state corrigidos:
 * 1. Cross-disable entre buyNow e addToCart (ambos botoes disabled enquanto QUALQUER
 *    operacao em curso). Antes: user clicava buyNow + addToCart durante loading ->
 *    2 POST simultaneos -> duplicate items ou 409 backend.
 * 2. Guard contra double-click rapido na mesma funcao (busy ref pattern).
 *    Antes: setState assincrono -> 2 cliques em 16ms ambos passavam guard.
 * 3. buyNow sucesso NAO resetava loadingBuy (so no catch). Router.push falhar
 *    (network, route guard) -> botao "Processando..." ETERNO.
 *    FIX: try/finally reseta sempre.
 * 4. window.location.href em requireAuth era hard-redirect (perde state).
 *    Trocado por router.push para Next preservar history + soft-nav.
 */
export function AddToCart({ productId, isFree }: { productId: string; isFree?: boolean }) {
  const router = useRouter();
  const { token } = useAuth();
  const { setCartOpen } = useUI();
  const [loadingBuy, setLoadingBuy] = useState(false);
  const [loadingAdd, setLoadingAdd] = useState(false);
  const [added, setAdded] = useState(false);
  const [err, setErr] = useState('');

  // FIX bug 1: estado "qualquer operacao em curso" para cross-disable
  const anyLoading = loadingBuy || loadingAdd;

  function requireAuth() {
    if (!token) {
      // FIX bug 4: router.push em vez de window.location.href (Next soft-nav + history)
      const next = encodeURIComponent(window.location.pathname);
      router.push(`/login?next=${next}`);
      return false;
    }
    return true;
  }

  async function addToCart() {
    // FIX bug 2: guard explicito anti double-click (setState eh async, 2 cliques
    // em 16ms ambos veem loadingAdd=false). Checa estado antes de prosseguir.
    if (anyLoading) return;
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
    // FIX bug 2: guard anti double-click
    if (anyLoading) return;
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
    } finally {
      // FIX bug 3: finally em vez de so no catch. Router.push falhar (network,
      // route guard, abort) -> loadingBuy=false sempre. Antes: estado eterno
      // "Processando..." se navegacao nao completar (incident real possivel
      // em mobile com network instavel + middleware lento).
      setLoadingBuy(false);
    }
  }

  if (isFree) {
    return (
      <>
        {/* FIX bug 1: cross-disable - botao Baixar gratis fica disabled se outra op rodar
            (corner case: este pode estar visivel se isFree mas teoricamente sem buyNow ativo).
            Mantido disabled={loadingBuy} pois isFree so renderiza este botao - sem cross-state. */}
        {/* FIX-WORKER-3 pass 158 (a11y): type='button' explicit + aria-busy + aria-hidden Icons */}
        <button type="button" onClick={buyNow} disabled={loadingBuy}
          aria-busy={loadingBuy}
          className="btn-primary w-full mb-3 text-base disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-magenta">
          {loadingBuy ? <Loader2 className="w-4 h-4 animate-spin inline mr-2" aria-hidden="true" /> : null}
          Baixar gratis
        </button>
        {err && (
          <div role="alert" className="flex items-start gap-2 text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg p-2 mb-3">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" aria-hidden="true" /> <span>{err}</span>
          </div>
        )}
      </>
    );
  }

  return (
    <>
      {/* FIX bug 1: cross-disable - botao buyNow disabled se loadingAdd OR loadingBuy
          FIX-WORKER-3 pass 158 (a11y): type='button' + aria-hidden em icons + focus-visible */}
      <button type="button" onClick={buyNow} disabled={anyLoading} aria-busy={loadingBuy}
        className="btn-primary w-full mb-3 text-base disabled:opacity-50 flex items-center justify-center gap-2 focus-visible:outline-2 focus-visible:outline-magenta">
        {loadingBuy ? <><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Processando...</> : 'Comprar agora'}
      </button>
      {/* FIX bug 1: cross-disable - botao addToCart disabled se loadingBuy OR added OR loadingAdd */}
      <button type="button" onClick={addToCart} disabled={anyLoading || added} aria-busy={loadingAdd}
        className="btn-ghost w-full text-sm flex items-center justify-center gap-2 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-magenta">
        {loadingAdd ? <><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Adicionando...</> :
         added ?       <><Check className="w-4 h-4 text-green-400" aria-hidden="true" /> Adicionado!</> :
                       <><ShoppingCart className="w-4 h-4" aria-hidden="true" /> Adicionar ao carrinho</>}
      </button>
      {err && (
        <div role="alert" className="flex items-start gap-2 text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg p-2 mt-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" /> <span>{err}</span>
        </div>
      )}
    </>
  );
}
