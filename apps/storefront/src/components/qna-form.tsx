'use client';

import { useState } from 'react';
import { MessageCircle, Send } from 'lucide-react';
import { Api } from '@/lib/api';
import { useAuth } from '@/lib/store';

// FIX-WORKER-3 pass 3: mapper friendly para erros qna (consistente com add-to-cart.tsx)
const QNA_ERROR_MESSAGES: Record<string, string> = {
  product_not_found:      'Produto nao encontrado ou foi removido.',
  spam_detected:          'Pergunta detectada como spam. Reformule de modo educado.',
  duplicate_question:     'Voce ja fez uma pergunta similar neste produto recentemente.',
  rate_limited:           'Voce esta perguntando muito rapido. Aguarde alguns minutos.',
  forbidden_role:         'Apenas compradores cadastrados podem fazer perguntas.',
  question_too_short:     'Pergunta muito curta. Use ao menos 5 caracteres.',
  question_too_long:      'Pergunta muito longa. Limite de 2000 caracteres.',
};
function friendlyQnaError(e: any): string {
  const code = e?.data?.error || e?.message || '';
  if (QNA_ERROR_MESSAGES[code]) return QNA_ERROR_MESSAGES[code];
  if (code === 'validation_error' && e?.data?.details?.length) {
    const d = e.data.details[0];
    if (d.code === 'too_small') return 'Pergunta muito curta (minimo 5 caracteres).';
    if (d.code === 'too_big')   return 'Pergunta muito longa (maximo 2000 caracteres).';
    return `Campo invalido: ${d.message || 'erro de validacao'}`;
  }
  return 'Erro ao enviar pergunta. Tente novamente em instantes.';
}

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
      <label className="text-sm font-semibold flex items-center gap-2">
        <MessageCircle className="w-4 h-4 text-magenta" /> Fazer uma pergunta
      </label>
      <div className="relative">
        <textarea value={q} onChange={(e) => setQ(e.target.value)} required minLength={MIN_LEN} maxLength={MAX_LEN} rows={3}
          placeholder="Ex: Quais APIs externas precisam? E compativel com Node 18+?"
          className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus:border-magenta focus:outline-none text-sm" />
        {/* FIX-WORKER-3 pass 3: contador de chars visivel (era erro so ao submit) */}
        <div className={`absolute bottom-2 right-3 text-[10px] ${
          trimmed.length > MAX_LEN ? 'text-red-400' :
          tooShort ? 'text-yellow-400' :
          trimmed.length > 0 ? 'text-green-400' : 'text-white/30'
        }`}>
          {trimmed.length}/{MAX_LEN}
        </div>
      </div>
      <button type="submit"
        disabled={!canSubmit}
        className="btn-primary text-sm flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed">
        <Send className="w-4 h-4" /> {loading ? 'Enviando...' : (token ? 'Enviar pergunta' : 'Login para perguntar')}
      </button>
      {/* FIX-WORKER-3 pass 3: ambos banners com botao fechar (UX consistente com cart/checkout) */}
      {msg && (
        <div className="text-sm text-green-400 bg-green-500/10 border border-green-500/30 rounded-lg p-2 flex items-start justify-between gap-2">
          <span>{msg}</span>
          <button type="button" onClick={() => setMsg('')} className="text-[10px] hover:underline">fechar</button>
        </div>
      )}
      {err && (
        <div role="alert" className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg p-2 flex items-start justify-between gap-2">
          <span>{err}</span>
          <button type="button" onClick={() => setErr('')} className="text-[10px] hover:underline">fechar</button>
        </div>
      )}
    </form>
  );
}
