'use client';

import { useState } from 'react';
import { MessageCircle, Send } from 'lucide-react';
import { Api } from '@/lib/api';
import { useAuth } from '@/lib/store';

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

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(''); setMsg('');
    if (!token) {
      window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
      return;
    }
    if (q.trim().length < 5) { setErr('Pergunta muito curta'); return; }
    setLoading(true);
    try {
      await Api.api('/qna', {
        method: 'POST', auth: token,
        body: JSON.stringify({ product_id: productId, question: q.trim() })
      });
      setQ('');
      setMsg('Pergunta enviada! O vendedor sera notificado.');
      if (onSubmitted) onSubmitted();
    } catch (e: any) {
      setErr(e.data?.message || e.message);
    } finally { setLoading(false); }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="text-sm font-semibold flex items-center gap-2">
        <MessageCircle className="w-4 h-4 text-magenta" /> Fazer uma pergunta
      </label>
      <textarea value={q} onChange={(e) => setQ(e.target.value)} required minLength={5} maxLength={2000} rows={3}
        placeholder="Ex: Funciona com WhatsApp Business API? Suporta Brasil?"
        className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus:border-magenta focus:outline-none text-sm" />
      <button type="submit" disabled={loading} className="btn-primary text-sm flex items-center gap-2 disabled:opacity-50">
        <Send className="w-4 h-4" /> {loading ? 'Enviando...' : (token ? 'Enviar pergunta' : 'Login para perguntar')}
      </button>
      {msg && <div className="text-sm text-green-400">{msg}</div>}
      {err && <div className="text-sm text-red-400">{err}</div>}
    </form>
  );
}
