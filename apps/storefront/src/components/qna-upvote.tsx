'use client';

import { useEffect, useState } from 'react';
import { ChevronUp } from 'lucide-react';
import { Api } from '@/lib/api';
import { useAuth } from '@/lib/store';

/**
 * Botao de upvote em uma pergunta Q&A (MLB-2).
 * Toggle: clique 1 vota, clique 2 desvota.
 */
export function QnaUpvote({ qnaId, initialCount = 0 }: { qnaId: string; initialCount?: number }) {
  const { token } = useAuth();
  const [count, setCount] = useState(initialCount);
  const [voted, setVoted] = useState(false);
  const [loading, setLoading] = useState(false);

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
    try {
      const r: any = await Api.api(`/qna/${qnaId}/upvote`, { method: 'POST', auth: token });
      setCount(r.upvote_count);
      setVoted(r.voted);
    } catch (e: any) {
      alert('Erro: ' + (e.data?.message || e.message));
    } finally { setLoading(false); }
  }

  return (
    <button onClick={toggle} disabled={loading}
      className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors ${
        voted ? 'bg-magenta/20 text-magenta-glow' : 'bg-white/5 hover:bg-white/10 text-white/60'
      } disabled:opacity-50`}
      title={voted ? 'Voto registrado - clique para remover' : 'Util? Vote para destacar'}>
      <ChevronUp className={`w-4 h-4 ${voted ? 'fill-magenta' : ''}`} />
      <span className="font-mono">{count}</span>
    </button>
  );
}
