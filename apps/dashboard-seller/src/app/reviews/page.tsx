'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { Star, MessageSquare, Send, ExternalLink } from 'lucide-react';
import { sellerFetch, fmtDate } from '@/lib/seller-api';
import { useSellerAction } from '@/lib/use-seller-action';

export default function SellerReviewsPage() {
  const [reviews, setReviews] = useState<any[]>([]);
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState('');

  async function load() {
    try {
      const r = await sellerFetch<{ reviews: any[] }>('/reviews/seller/received');
      setReviews(r.reviews || []);
      setLoadError('');
    } catch (e: any) { setLoadError(e.message); }
  }
  useEffect(() => { load(); }, []);

  // FIX-WORKER-5 pass 7: substitui alert(e.message) browser-blocking + setLoading
  // global. Mesmo pattern de W5 passes 1-6 (products, qna, loja, products/[id],
  // upload, financeiro). Esta era ULTIMA page com alert() na seller dash.
  const action = useSellerAction(load);

  async function reply(id: string) {
    const text = (replies[id] || '').trim();
    if (!text) return;
    action.run(`reply-${id}`, async () => {
      await sellerFetch(`/reviews/${id}/reply`, {
        method: 'POST', body: JSON.stringify({ reply: text })
      });
      // FIX-WORKER-5 pass 7: functional setState evita stale closure se 2 replies
      // forem despachadas simultaneamente (improvavel mas safe-by-default)
      setReplies((p) => ({ ...p, [id]: '' }));
      return `Resposta publicada na avaliacao ${id.slice(0, 8)}...`;
    });
  }

  const avgRating = reviews.length > 0
    ? (reviews.reduce((s, r) => s + r.rating, 0) / reviews.length).toFixed(1) : '-';
  const pendingReply = reviews.filter((r) => !r.reply_from_seller).length;

  return (
    <div>
      <h1 className="font-display font-bold text-4xl mb-2">Avaliacoes recebidas</h1>
      <p className="text-white/60 mb-8">{reviews.length} review(s) - {pendingReply} sem resposta</p>

      <div className="grid md:grid-cols-3 gap-4 mb-8">
        <div className="glass p-5">
          <div className="text-xs text-white/50 uppercase">Total de reviews</div>
          <div className="font-display font-bold text-3xl text-magenta-glow">{reviews.length}</div>
        </div>
        <div className="glass p-5">
          <div className="text-xs text-white/50 uppercase">Avaliacao media</div>
          <div className="font-display font-bold text-3xl flex items-center gap-2">
            {avgRating}
            <Star className="w-6 h-6 fill-yellow-400 text-yellow-400" aria-hidden="true" />
          </div>
        </div>
        <div className="glass p-5">
          <div className="text-xs text-white/50 uppercase">Sem resposta</div>
          <div className="font-display font-bold text-3xl text-yellow-400">{pendingReply}</div>
        </div>
      </div>

      {/* FIX-WORKER-5 pass 7: banners centralizados via useSellerAction (era err ad-hoc) */}
      {loadError && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg mb-4 flex items-center justify-between">
          <span>Erro carregando avaliacoes: {loadError}</span>
          <button onClick={() => { setLoadError(''); load(); }} className="text-xs hover:underline">retry</button>
        </div>
      )}
      {action.error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg mb-4 flex items-center justify-between">
          <span>{action.error}</span>
          <button onClick={action.clear} className="text-xs hover:underline">fechar</button>
        </div>
      )}
      {action.success && (
        <div className="bg-green-500/10 border border-green-500/30 text-green-400 p-4 rounded-lg mb-4 flex items-center justify-between">
          <span>{action.success}</span>
          <button onClick={action.clear} className="text-xs hover:underline">fechar</button>
        </div>
      )}

      {reviews.length === 0 ? (
        <div className="glass p-12 text-center text-white/60">
          <MessageSquare className="w-16 h-16 mx-auto mb-4 text-white/30" aria-hidden="true" />
          {loadError ? 'Nao foi possivel carregar as avaliacoes.' : 'Voce ainda nao recebeu avaliacoes. Quando seus clientes avaliarem, elas aparecerao aqui.'}
        </div>
      ) : (
        <div className="space-y-4">
          {reviews.map((r) => {
            // FIX-WORKER-5 pass 7: per-row busy state (era loading GLOBAL).
            // Antes: clicar Responder em row A travava TODOS botoes.
            // Agora: action.busyKey === `reply-${r.id}` por row.
            const busy = action.busyKey === `reply-${r.id}`;
            return (
            <div key={r.id} className="glass p-5">
              <div className="flex items-start gap-4 mb-3">
                {/* FIX-WORKER-8 pattern: <img> -> next/image */}
                {r.cover_image_url && (
                  <div className="w-12 h-12 relative rounded overflow-hidden flex-shrink-0">
                    <Image src={r.cover_image_url} alt={r.product_title || 'Produto'}
                      fill sizes="48px" className="object-cover" />
                  </div>
                )}
                <div className="flex-1">
                  <Link href={`/products/${r.product_id}`} className="text-sm font-display font-semibold hover:text-magenta">
                    {r.product_title} <ExternalLink className="w-3 h-3 inline ml-1" aria-hidden="true" />
                  </Link>
                  <div className="flex items-center gap-2 mt-1">
                    {/* FIX-WORKER-5 pass 7: role=img + aria-label no container, aria-hidden nas estrelas */}
                    <div className="flex" role="img" aria-label={`${r.rating} de 5 estrelas`}>
                      {Array.from({ length: r.rating }).map((_, i) => (
                        <Star key={i} className="w-4 h-4 fill-yellow-400 text-yellow-400" aria-hidden="true" />
                      ))}
                      {Array.from({ length: 5 - r.rating }).map((_, i) => (
                        <Star key={i} className="w-4 h-4 text-white/20" aria-hidden="true" />
                      ))}
                    </div>
                    {r.is_verified_purchase && (
                      <span className="text-[10px] px-1.5 py-0.5 bg-green-500/20 text-green-400 rounded">
                        COMPRA VERIFICADA
                      </span>
                    )}
                    <span className="text-xs text-white/40 ml-auto">{fmtDate(r.created_at)}</span>
                  </div>
                </div>
              </div>

              {r.title && <div className="font-semibold text-sm mb-1">{r.title}</div>}
              {r.body && <p className="text-sm text-white/80 mb-3">{r.body}</p>}

              <div className="text-xs text-white/40 mb-3">
                por {r.buyer_name || r.buyer_email || 'Cliente'}
              </div>

              {r.reply_from_seller ? (
                <div className="border-l-2 border-magenta pl-3 ml-3">
                  <div className="text-xs text-magenta uppercase mb-1">Sua resposta</div>
                  <p className="text-sm text-white/70">{r.reply_from_seller}</p>
                  <div className="text-xs text-white/40 mt-1">{fmtDate(r.reply_at)}</div>
                </div>
              ) : (
                <div className="border-t border-white/5 pt-3 mt-3 space-y-2">
                  <textarea
                    value={replies[r.id] || ''}
                    onChange={(e) => setReplies((p) => ({ ...p, [r.id]: e.target.value }))}
                    placeholder="Responda esta avaliacao publicamente..."
                    rows={2}
                    disabled={busy}
                    aria-label={`Resposta para avaliacao de ${r.buyer_name || 'cliente'}`}
                    className="w-full px-3 py-2 rounded bg-white/5 border border-white/10 text-sm focus:border-magenta focus:outline-none disabled:opacity-50" />
                  <button onClick={() => reply(r.id)} disabled={busy || !replies[r.id]?.trim()}
                    className="btn-primary text-xs flex items-center gap-1 disabled:opacity-50 disabled:cursor-wait">
                    <Send className="w-3 h-3" aria-hidden="true" /> {busy ? 'Enviando...' : 'Responder'}
                  </button>
                </div>
              )}
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
