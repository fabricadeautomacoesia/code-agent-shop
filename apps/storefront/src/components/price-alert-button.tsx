'use client';

/**
 * MLB-12 (NEW): Botao "Avise-me se baixar" no PDP.
 *
 * - Sem auth: redireciona para /login com return URL
 * - Auth: POST /products/price-alerts (toggle ativacao)
 * - State: active/inactive baseado em check inicial
 *
 * UX similar ao Mercado Livre "Quero ser avisado quando baixar".
 *
 * FIX-WORKER-3 pass 9 (a11y/UX hardening - mesmo pattern WishlistButton pass 6):
 * - aria-label + aria-pressed + aria-hidden em icones
 * - optimistic update + rollback em erro
 * - errorFlash visual (ring-2 ring-red animate-pulse 2s)
 * - focus-visible outline magenta
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, BellRing } from 'lucide-react';
import { Api } from '@/lib/api';
import { useAuth } from '@/lib/store';

interface Props {
  productId: string;
  currentPriceCents: number;
}

export function PriceAlertButton({ productId, currentPriceCents: _unused }: Props) {
  const router = useRouter();
  const { token } = useAuth();
  const [active, setActive] = useState(false);
  const [loading, setLoading] = useState(false);
  // FIX-WORKER-3 pass 9: errorFlash visual feedback (era silent catch {})
  const [errorFlash, setErrorFlash] = useState(false);

  // FIX-WORKER-3 pass 6: usa endpoint /check/:productId especifico (backend novo).
  // ANTES: GET /products/price-alerts listava TODOS 100 alertas + .some(filter)
  // - User com 50 alertas -> ~5KB JSON parsed para descobrir 1 boolean
  // - Query DB: scan completo product_price_alerts WHERE user_id (sem productId filter)
  // - N+1 implicito se PriceAlertButton for adicionado em listas/cards
  // AGORA: GET /check/:productId -> query indexada (user_id, product_id), 50 bytes
  useEffect(() => {
    if (!token) return;
    Api.api<{ active: boolean }>(`/products/price-alerts/check/${productId}`, { auth: token })
      .then((r) => setActive(!!r.active))
      .catch(() => {});
  }, [token, productId]);

  async function toggle() {
    // FIX-WORKER-3 pass 6 (Pattern B): explicit guard anti double-click.
    // setLoading async (next React tick). 2 cliques em <16ms ambos veem loading=false.
    // IMPACTO PRE-FIX:
    //   a. optimistic flip 2x: setActive(!wasActive) duas vezes = volta visual ao original
    //   b. 2 POST/DELETE simultaneos: backend 409 ON CONFLICT DO UPDATE absorve mas
    //      DELETE em quem ja nao existe pode 404 (mesmo bug WishlistButton pass 4).
    //   c. errorFlash race: piscar duplo durante setTimeout 2s.
    // Mesmo bug AddToCart pass 3 #2 e WishlistButton pass 4.
    if (loading) return;
    if (!token) {
      router.push(`/login?return=/product/${productId}`);
      return;
    }
    // FIX-WORKER-3 pass 9: optimistic flip + rollback em erro
    // Antes: setActive APOS request OK = delay 200-400ms visual.
    // Em erro: setActive nao revertia + catch {} silent -> dessincronizacao state vs DB.
    const wasActive = active;
    setLoading(true);
    setErrorFlash(false);
    setActive(!wasActive); // optimistic flip imediato
    try {
      if (wasActive) {
        await Api.api(`/products/price-alerts/${productId}`, { method: 'DELETE', auth: token });
      } else {
        await Api.api('/products/price-alerts', {
          method: 'POST', auth: token,
          body: JSON.stringify({ product_id: productId }),
        });
      }
    } catch (err: any) {
      // 404 not_found em DELETE: estado optimistic ja correto
      if (err?.status === 404 && wasActive) return;
      // Outros erros: rollback + visual feedback
      setActive(wasActive);
      setErrorFlash(true);
      setTimeout(() => setErrorFlash(false), 2000);
      // eslint-disable-next-line no-console
      console.error('[PriceAlert]', err?.data?.error || err?.message);
    } finally { setLoading(false); }
  }

  return (
    /* FIX-WORKER-3 pass 159 (a11y): type='button' defensive (V8 Regra 23)
       FIX-WORKER-3 pass 573 (a11y - aria-busy paridade cadeia pass 549/552/553/568):
       PRE-FIX: aria-label dinamico mas SEM aria-busy={loading}.
       - SR (NVDA modern) usam aria-busy p/ silenciar live regions enquanto processing
       - Sem aria-busy = SR pode anunciar 'Removendo alerta' continuamente
       - Inconsistente com cadeia W1/W2/W3 authflows + CTAs (consolidacao
         passes 549 esqueci-senha + 552 checkout + 553 qna-form + 568 financeiro).
       POST-FIX: + aria-busy={loading} + aria-label upgrade durante loading.
       Paridade pattern V8 W3 PDP CTAs (add-to-cart pass 121 + qna-form pass 553). */
    <button type="button" onClick={toggle} disabled={loading}
      aria-busy={loading}
      aria-label={loading
        ? 'Processando alerta de preco'
        : (active ? 'Remover alerta de preco' : 'Receber email quando o preco baixar')}
      aria-pressed={active}
      title={active ? 'Voce sera notificado se o preco baixar' : 'Receber email se o preco baixar'}
      className={`w-full px-4 py-2.5 rounded-lg border-2 text-sm font-medium transition-all disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-magenta ${
        active
          /* FIX-WORKER-8 pass 266 (active state hover parity):
             Paridade com wishlist-button pass 231 - state ativo sem hover feedback
             parecia estatico. hover:bg-magenta/20 sutil indica clicavel. */
          ? 'border-magenta bg-magenta/10 hover:bg-magenta/20 text-magenta-glow'
          : 'border-white/10 bg-white/5 hover:border-white/30 hover:bg-white/10 text-white/70'
      } ${errorFlash ? 'ring-2 ring-red-500 animate-pulse' : ''}`}>
      <div className="flex items-center justify-center gap-2">
        {active
          ? <BellRing className="w-4 h-4" aria-hidden="true" />
          : <Bell className="w-4 h-4" aria-hidden="true" />}
        <span>
          {loading ? '...' : (active ? 'Alerta ativo (clique para remover)' : 'Avise-me se o preco baixar')}
        </span>
      </div>
    </button>
  );
}
