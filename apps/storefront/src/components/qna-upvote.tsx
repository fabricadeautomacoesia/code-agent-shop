'use client';

import { useEffect, useState } from 'react';
import { ChevronUp } from 'lucide-react';
import { Api } from '@/lib/api';
import { useAuth } from '@/lib/store';

/**
 * Botao de upvote em uma pergunta Q&A (MLB-2).
 * Toggle: clique 1 vota, clique 2 desvota.
 *
 * FIX-WORKER-3 pass 152 (a11y):
 *  - alert('Erro: ...') -> inline error tooltip + aria-live polite
 *  - aria-pressed (toggle state semantica)
 *  - aria-label dinamico com count + voted state
 *  - ChevronUp aria-hidden (decorativo)
 */
export function QnaUpvote({ qnaId, initialCount = 0 }: { qnaId: string; initialCount?: number }) {
  const { token } = useAuth();
  const [count, setCount] = useState(initialCount);
  const [voted, setVoted] = useState(false);
  const [loading, setLoading] = useState(false);
  // FIX-WORKER-3 pass 152: error state inline (substitui alert nativo)
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!token) return;
    Api.api<{ voted: boolean }>(`/qna/${qnaId}/voted`, { auth: token })
      .then((r) => setVoted(r.voted))
      .catch(() => {});
  }, [token, qnaId]);

  async function toggle() {
    if (!token) {
      window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
      return;
    }
    setLoading(true);
    setErr('');
    try {
      const r: any = await Api.api(`/qna/${qnaId}/upvote`, { method: 'POST', auth: token });
      setCount(r.upvote_count);
      setVoted(r.voted);
    } catch (e: any) {
      // FIX-WORKER-3 pass 152: substitui alert() por inline error c/ auto-clear 5s
      const msg = e.data?.message || e.message || 'Erro ao votar';
      setErr(msg);
      setTimeout(() => setErr(''), 5000);
    } finally { setLoading(false); }
  }

  // FIX-WORKER-3 pass 152: aria-label dinamico - SR anuncia contexto completo
  const ariaLabel = voted
    ? `Remover voto. ${count} ${count === 1 ? 'voto' : 'votos'} total.`
    : `Votar como util. ${count} ${count === 1 ? 'voto' : 'votos'} total.`;

  return (
    <div className="inline-flex flex-col gap-1 items-start">
      <button onClick={toggle} disabled={loading}
        type="button"
        aria-pressed={voted}
        aria-label={ariaLabel}
        className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors focus-visible:outline-2 focus-visible:outline-magenta ${
          voted ? 'bg-magenta/20 text-magenta-glow' : 'bg-white/5 hover:bg-white/10 text-white/60'
        } disabled:opacity-50`}
        title={voted ? 'Voto registrado - clique para remover' : 'Util? Vote para destacar'}>
        <ChevronUp className={`w-4 h-4 ${voted ? 'fill-magenta' : ''}`} aria-hidden="true" />
        <span className="font-mono">{count}</span>
      </button>
      {/* FIX-WORKER-3 pass 152: inline error com role=alert (era alert() nativo) */}
      {err && (
        <div role="alert"
          className="text-[10px] text-red-400 bg-red-500/10 border border-red-500/30 rounded px-1.5 py-0.5 max-w-[200px]">
          {err}
        </div>
      )}
    </div>
  );
}
