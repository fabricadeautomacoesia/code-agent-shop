'use client';

import { useState } from 'react';
import { Star, Send } from 'lucide-react';
import { Api } from '@/lib/api';
import { useAuth } from '@/lib/store';

// FIX-WORKER-3 pass 10 (DRY): friendlyReviewError movido para lib/friendly-errors.ts
import { friendlyReviewError } from '@/lib/friendly-errors';

const TITLE_MAX = 200;
const BODY_MAX = 5000;

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

  const titleOk = title.length <= TITLE_MAX;
  const bodyOk = body.length <= BODY_MAX;
  const canSubmit = !loading && rating >= 1 && rating <= 5 && titleOk && bodyOk;

  function showErr(msg: string) {
    setErr(msg);
    // FIX-WORKER-3 pass 4: auto-clear 5s (era persistente)
    setTimeout(() => setErr(''), 5000);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (rating === 0) { showErr('Selecione uma nota de 1 a 5 estrelas.'); return; }
    if (!titleOk) { showErr(`Titulo muito longo (max ${TITLE_MAX} caracteres).`); return; }
    if (!bodyOk) { showErr(`Comentario muito longo (max ${BODY_MAX} caracteres).`); return; }
    setLoading(true); setErr('');
    try {
      await Api.api('/reviews', {
        method: 'POST', auth: token!,
        body: JSON.stringify({ product_id: productId, order_id: orderId, rating, title, body })
      });
      setOk(true);
      if (onSubmitted) onSubmitted();
    } catch (e: any) {
      // FIX-WORKER-3 pass 4: mapper completo (era so 1 case: already_reviewed)
      showErr(friendlyReviewError(e));
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
              aria-label={`Avaliar ${n} ${n === 1 ? 'estrela' : 'estrelas'}`}
              aria-pressed={rating === n}
              className="p-1 hover:scale-110 transition-transform focus-visible:outline-2 focus-visible:outline-magenta rounded">
              <Star className={`w-8 h-8 ${(hoverRating || rating) >= n ? 'fill-yellow-400 text-yellow-400' : 'text-white/20'}`} />
            </button>
          ))}
          {rating > 0 && <span className="ml-3 self-center font-bold text-lg">{rating}/5</span>}
        </div>
      </div>

      <div>
        <label className="text-xs text-white/60 uppercase block mb-1">Titulo (opcional)</label>
        <div className="relative">
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={TITLE_MAX}
            placeholder="Ex: Funcionou perfeitamente"
            className="w-full px-3 py-2 pr-16 rounded-lg bg-white/5 border border-white/10 focus:border-magenta focus:outline-none text-sm" />
          {/* FIX-WORKER-3 pass 4: contador chars visivel (consistente com qna-form) */}
          {title.length > 0 && (
            <div className={`absolute right-2 top-1/2 -translate-y-1/2 text-[10px] ${
              title.length > TITLE_MAX ? 'text-red-400' :
              title.length > TITLE_MAX * 0.9 ? 'text-yellow-400' : 'text-white/40'
            }`}>
              {title.length}/{TITLE_MAX}
            </div>
          )}
        </div>
      </div>

      <div>
        <label className="text-xs text-white/60 uppercase block mb-1">Comentario (opcional)</label>
        <div className="relative">
          <textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={BODY_MAX} rows={4}
            placeholder="Conte sua experiencia com este produto..."
            className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus:border-magenta focus:outline-none text-sm" />
          {body.length > 0 && (
            <div className={`absolute bottom-2 right-3 text-[10px] ${
              body.length > BODY_MAX ? 'text-red-400' :
              body.length > BODY_MAX * 0.9 ? 'text-yellow-400' : 'text-white/40'
            }`}>
              {body.length}/{BODY_MAX}
            </div>
          )}
        </div>
      </div>

      {/* FIX-WORKER-3 pass 4: banner err consistente com qna-form (border+icon+fechar) */}
      {err && (
        <div role="alert" className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg p-2 flex items-start justify-between gap-2">
          <span>{err}</span>
          <button type="button" onClick={() => setErr('')} className="text-[10px] hover:underline">fechar</button>
        </div>
      )}

      <button type="submit" disabled={!canSubmit}
        className="btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed">
        <Send className="w-4 h-4" /> {loading ? 'Enviando...' : 'Publicar avaliacao'}
      </button>
    </form>
  );
}
