'use client';

import { useState } from 'react';
import { Star, Send } from 'lucide-react';
import { Api } from '@/lib/api';
import { useAuth } from '@/lib/store';

/**
 * Form de review pos-compra. Apenas para is_verified_purchase.
 * V8 §21.x - reviews verificadas.
 */
export function ReviewForm({ productId, orderId, productTitle, onSubmitted }: {
  productId: string; orderId: string; productTitle: string; onSubmitted?: () => void;
}) {
  const { token } = useAuth();
  const [rating, setRating] = useState(0);
  const [hoverRating, setHoverRating] = useState(0);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(false);
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (rating === 0) { setErr('Selecione uma nota'); return; }
    setLoading(true); setErr('');
    try {
      await Api.api('/reviews', {
        method: 'POST', auth: token!,
        body: JSON.stringify({ product_id: productId, order_id: orderId, rating, title, body })
      });
      setOk(true);
      if (onSubmitted) onSubmitted();
    } catch (e: any) {
      if (e.data?.error === 'already_reviewed') setErr('Voce ja avaliou este produto');
      else setErr(e.data?.message || e.message);
    } finally { setLoading(false); }
  }

  if (ok) {
    return (
      <div className="glass p-6 border-l-4 border-green-500 text-center">
        <div className="text-green-400 font-display font-bold text-lg mb-2">Obrigado pela avaliacao!</div>
        <p className="text-sm text-white/70">Sua opiniao ajuda outros compradores a decidir.</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="glass p-6 space-y-4">
      <h3 className="font-display font-bold text-lg">Avalie {productTitle}</h3>

      <div>
        <label className="text-xs text-white/60 uppercase block mb-2">Nota</label>
        <div className="flex gap-1">
          {[1,2,3,4,5].map((n) => (
            <button key={n} type="button"
              onClick={() => setRating(n)}
              onMouseEnter={() => setHoverRating(n)}
              onMouseLeave={() => setHoverRating(0)}
              className="p-1 hover:scale-110 transition-transform">
              <Star className={`w-8 h-8 ${(hoverRating || rating) >= n ? 'fill-yellow-400 text-yellow-400' : 'text-white/20'}`} />
            </button>
          ))}
          {rating > 0 && <span className="ml-3 self-center font-bold text-lg">{rating}/5</span>}
        </div>
      </div>

      <div>
        <label className="text-xs text-white/60 uppercase block mb-1">Titulo (opcional)</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200}
          placeholder="Ex: Funcionou perfeitamente"
          className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus:border-magenta focus:outline-none text-sm" />
      </div>

      <div>
        <label className="text-xs text-white/60 uppercase block mb-1">Comentario (opcional)</label>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} rows={4}
          placeholder="Conte sua experiencia com este produto..."
          className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus:border-magenta focus:outline-none text-sm" />
      </div>

      {err && <div className="text-sm text-red-400 bg-red-500/10 p-2 rounded">{err}</div>}

      <button type="submit" disabled={loading || rating === 0} className="btn-primary flex items-center gap-2 disabled:opacity-50">
        <Send className="w-4 h-4" /> {loading ? 'Enviando...' : 'Publicar avaliacao'}
      </button>
    </form>
  );
}
