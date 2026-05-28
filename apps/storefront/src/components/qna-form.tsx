'use client';

import { useState } from 'react';
import { MessageCircle, Send } from 'lucide-react';
import { Api } from '@/lib/api';
import { useAuth } from '@/lib/store';

// FIX-WORKER-3 pass 10 (DRY): friendlyQnaError movido para lib/friendly-errors.ts
import { friendlyQnaError } from '@/lib/friendly-errors';

const MIN_LEN = 5;
const MAX_LEN = 2000;

/**
 * Form de pergunta publica no PDP (Mercado Livre style).
 * Envia POST /api/qna se logado, redirect para /login se nao.
 */
export function QnaForm({ productId, onSubmitted }: { productId: string; onSubmitted?: () => void }) {
  const { token } = useAuth();
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const trimmed = q.trim();
  const tooShort = trimmed.length > 0 && trimmed.length < MIN_LEN;
  const canSubmit = !loading && trimmed.length >= MIN_LEN && trimmed.length <= MAX_LEN;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(''); setMsg('');
    if (!token) {
      window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
      return;
    }
    // FIX-WORKER-3 pass 3: este check ja deveria estar barrado pelo disabled
    // do botao, mas defesa em profundidade contra submit programatico via Enter.
    if (trimmed.length < MIN_LEN) {
      setErr(`Pergunta muito curta (minimo ${MIN_LEN} caracteres).`);
      setTimeout(() => setErr(''), 5000);
      return;
    }
    setLoading(true);
    try {
      await Api.api('/qna', {
        method: 'POST', auth: token,
        body: JSON.stringify({ product_id: productId, question: trimmed })
      });
      setQ('');
      setMsg('Pergunta enviada! O vendedor sera notificado e respondera em ate 24h.');
      // FIX-WORKER-3 pass 3: auto-clear de msg apos 5s (era persistent)
      setTimeout(() => setMsg(''), 5000);
      if (onSubmitted) onSubmitted();
    } catch (e: any) {
      // FIX-WORKER-3 pass 3: friendly mapping vs erro raw backend
      setErr(friendlyQnaError(e));
      setTimeout(() => setErr(''), 5000);
    } finally { setLoading(false); }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      {/* FIX-WORKER-3 pass 137 (a11y): label htmlFor + textarea id (WCAG 1.3.1).
          Antes: <label> SEM htmlFor + <textarea> SEM id -> screen readers
          desassociavam label e campo. NVDA/JAWS anunciavam apenas 'campo edicao'. */}
      <label htmlFor="qna-question" className="text-sm font-semibold flex items-center gap-2">
        <MessageCircle className="w-4 h-4 text-magenta" aria-hidden="true" /> Fazer uma pergunta
      </label>
      <div className="relative">
        {/* FIX-WORKER-3 pass 137: id + aria-describedby p/ counter SR-friendly */}
        <textarea id="qna-question" value={q} onChange={(e) => setQ(e.target.value)}
          required minLength={MIN_LEN} maxLength={MAX_LEN} rows={3}
          aria-describedby="qna-counter"
          placeholder="Ex: Quais APIs externas precisam? E compativel com Node 18+?"
          className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus:border-magenta focus:outline-none text-sm" />
        {/* FIX-WORKER-3 pass 3: contador de chars visivel (era erro so ao submit)
            FIX-WORKER-3 pass 137 (a11y): id + aria-live polite p/ SR anunciar mudancas */}
        <div id="qna-counter" aria-live="polite"
          className={`absolute bottom-2 right-3 text-[10px] ${
          trimmed.length > MAX_LEN ? 'text-red-400' :
          tooShort ? 'text-yellow-400' :
          trimmed.length > 0 ? 'text-green-400' : 'text-white/30'
        }`}>
          {trimmed.length}/{MAX_LEN}
        </div>
      </div>
      {/* FIX-WORKER-3 pass 186 (a11y): aria-hidden em icone decorativo + focus-visible
          + aria-label dinamico contextual SR */}
      <button type="submit"
        disabled={!canSubmit}
        aria-label={loading ? 'Enviando pergunta' : (token ? 'Enviar pergunta sobre o produto' : 'Fazer login para perguntar')}
        className="btn-primary text-sm flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-magenta">
        <Send className="w-4 h-4" aria-hidden="true" /> {loading ? 'Enviando...' : (token ? 'Enviar pergunta' : 'Login para perguntar')}
      </button>
      {/* FIX-WORKER-3 pass 3: ambos banners com botao fechar (UX consistente com cart/checkout)
          FIX-WORKER-3 pass 137 (a11y): role=status + aria-live polite no msg success
          (era apenas visual - SR nao anunciava sucesso de submissao). */}
      {/* FIX-WORKER-3 pass 186 (a11y): aria-label semantico + focus-visible */}
      {msg && (
        <div role="status" aria-live="polite"
          className="text-sm text-green-400 bg-green-500/10 border border-green-500/30 rounded-lg p-2 flex items-start justify-between gap-2">
          <span>{msg}</span>
          <button type="button" onClick={() => setMsg('')}
            aria-label="Fechar mensagem de sucesso"
            className="text-[10px] hover:underline focus-visible:outline-2 focus-visible:outline-green-400 rounded">fechar</button>
        </div>
      )}
      {err && (
        <div role="alert" className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg p-2 flex items-start justify-between gap-2">
          <span>{err}</span>
          <button type="button" onClick={() => setErr('')}
            aria-label="Fechar mensagem de erro"
            className="text-[10px] hover:underline focus-visible:outline-2 focus-visible:outline-red-400 rounded">fechar</button>
        </div>
      )}
    </form>
  );
}
