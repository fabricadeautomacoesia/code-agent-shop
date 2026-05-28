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
  // FIX-WORKER-5 pass 373: KPIs cross-page (server-side aggregate vs client-side reduce)
  const [stats, setStats] = useState<{ total: number; avg_rating: number | null; pending_reply_count: number }>({
    total: 0, avg_rating: null, pending_reply_count: 0,
  });

  async function load() {
    try {
      const r = await sellerFetch<{
        reviews: any[]; total: number; avg_rating: number | null; pending_reply_count: number;
      }>('/reviews/seller/received');
      setReviews(r.reviews || []);
      // FIX pass 373: stats agregados backend (todos seller reviews, nao so pagina)
      setStats({
        total: Number(r.total || 0),
        avg_rating: r.avg_rating !== null && r.avg_rating !== undefined ? Number(r.avg_rating) : null,
        pending_reply_count: Number(r.pending_reply_count || 0),
      });
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

  // FIX-WORKER-5 pass 373: usar stats agregados backend (era client reduce - subset)
  // PRE-FIX: avgRating calculado SO da pagina atual (max 50). Seller 500 reviews
  //   via avg de 50 -> KPI errado. POST-FIX: stats.avg_rating cobre TODOS reviews.
  const avgRating = stats.avg_rating !== null ? stats.avg_rating.toFixed(1) : '-';
  const pendingReply = stats.pending_reply_count;
  const totalReviews = stats.total;

  return (
    <div>
      <h1 className="font-display font-bold text-4xl mb-2">Avaliacoes recebidas</h1>
      <p className="text-white/60 mb-8">{totalReviews} review(s) - {pendingReply} sem resposta</p>

      <div className="grid md:grid-cols-3 gap-4 mb-8">
        <div className="glass p-5">
          <div className="text-xs text-white/50 uppercase">Total de reviews</div>
          <div className="font-display font-bold text-3xl text-magenta-glow">{totalReviews}</div>
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
      {/* FIX-WORKER-5 pass 7 + 172 (a11y V8 R23): role=alert/status + type=button + aria-label */}
      {loadError && (
        <div role="alert" className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg mb-4 flex items-center justify-between">
          <span>Erro carregando avaliacoes: {loadError}</span>
          <button type="button" onClick={() => { setLoadError(''); load(); }}
            aria-label="Tentar carregar avaliacoes novamente"
            className="text-xs hover:underline focus-visible:outline-2 focus-visible:outline-red-400 rounded">retry</button>
        </div>
      )}
      {action.error && (
        <div role="alert" className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg mb-4 flex items-center justify-between">
          <span>{action.error}</span>
          <button type="button" onClick={action.clear} aria-label="Fechar mensagem de erro"
            className="text-xs hover:underline focus-visible:outline-2 focus-visible:outline-red-400 rounded">fechar</button>
        </div>
      )}
      {action.success && (
        <div role="status" aria-live="polite" className="bg-green-500/10 border border-green-500/30 text-green-400 p-4 rounded-lg mb-4 flex items-center justify-between">
          <span>{action.success}</span>
          <button type="button" onClick={action.clear} aria-label="Fechar mensagem de sucesso"
            className="text-xs hover:underline focus-visible:outline-2 focus-visible:outline-green-400 rounded">fechar</button>
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
                {/* FIX-WORKER-5 pass 330: textarea maxLength + char counter UX.
                    PRE-FIX: sem limit client - user digita >2000 chars -> backend
                    reject com generic error (Zod max). UX confuso.
                    POST-FIX: maxLength=2000 HTML + counter visual + over-limit warn. */}
                <div className="border-t border-white/5 pt-3 mt-3 space-y-2">
                  <textarea
                    value={replies[r.id] || ''}
                    onChange={(e) => setReplies((p) => ({ ...p, [r.id]: e.target.value }))}
                    placeholder="Responda esta avaliacao publicamente..."
                    rows={2}
                    maxLength={2000}
                    disabled={busy}
                    aria-label={`Resposta para avaliacao de ${r.buyer_name || 'cliente'}`}
                    aria-describedby={`reply-counter-${r.id}`}
                    className="w-full px-3 py-2 rounded bg-white/5 border border-white/10 text-sm focus:border-magenta focus:outline-none disabled:opacity-50" />
                  <div id={`reply-counter-${r.id}`} aria-live="polite"
                    className={`text-[10px] text-right ${
                      (replies[r.id]?.length || 0) > 1900 ? 'text-yellow-400' : 'text-white/30'
                    }`}>
                    {replies[r.id]?.length || 0}/2000
                  </div>
                  {/* FIX-WORKER-5 pass 172 (a11y V8 R23): type=button + aria-label */}
                  <button type="button" onClick={() => reply(r.id)} disabled={busy || !replies[r.id]?.trim()}
                    aria-label={`Enviar resposta para avaliacao de ${r.buyer_name || 'cliente'}`}
                    className="btn-primary text-xs flex items-center gap-1 disabled:opacity-50 disabled:cursor-wait focus-visible:outline-2 focus-visible:outline-magenta">
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
