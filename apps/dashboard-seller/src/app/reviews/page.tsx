'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Star, MessageSquare, Send, ExternalLink, Clock } from 'lucide-react';
import { sellerFetch, fmtDate } from '@/lib/seller-api';

export default function SellerReviewsPage() {
  const [reviews, setReviews] = useState<any[]>([]);
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  async function load() {
    try {
      const r = await sellerFetch<{ reviews: any[] }>('/reviews/seller/received');
      setReviews(r.reviews);
    } catch (e: any) { setErr(e.message); }
  }
  useEffect(() => { load(); }, []);

  async function reply(id: string) {
    const text = replies[id]?.trim();
    if (!text) return;
    setLoading(true);
    try {
      await sellerFetch(`/reviews/${id}/reply`, {
        method: 'POST', body: JSON.stringify({ reply: text })
      });
      setReplies({ ...replies, [id]: '' });
      load();
    } catch (e: any) { alert(e.message); }
    finally { setLoading(false); }
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
            <Star className="w-6 h-6 fill-yellow-400 text-yellow-400" />
          </div>
        </div>
        <div className="glass p-5">
          <div className="text-xs text-white/50 uppercase">Sem resposta</div>
          <div className="font-display font-bold text-3xl text-yellow-400">{pendingReply}</div>
        </div>
      </div>

      {err && <div className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded mb-4">{err}</div>}

      {reviews.length === 0 ? (
        <div className="glass p-12 text-center text-white/60">
          <MessageSquare className="w-16 h-16 mx-auto mb-4 text-white/30" />
          Voce ainda nao recebeu avaliacoes. Quando seus clientes avaliarem, elas aparecerao aqui.
        </div>
      ) : (
        <div className="space-y-4">
          {reviews.map((r) => (
            <div key={r.id} className="glass p-5">
              <div className="flex items-start gap-4 mb-3">
                {r.cover_image_url && (
                  <img src={r.cover_image_url} alt="" className="w-12 h-12 object-cover rounded" />
                )}
                <div className="flex-1">
                  <Link href={`/products/${r.product_id}`} className="text-sm font-display font-semibold hover:text-magenta">
                    {r.product_title} <ExternalLink className="w-3 h-3 inline ml-1" />
                  </Link>
                  <div className="flex items-center gap-2 mt-1">
                    <div className="flex">
                      {Array.from({ length: r.rating }).map((_, i) => (
                        <Star key={i} className="w-4 h-4 fill-yellow-400 text-yellow-400" />
                      ))}
                      {Array.from({ length: 5 - r.rating }).map((_, i) => (
                        <Star key={i} className="w-4 h-4 text-white/20" />
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
                    onChange={(e) => setReplies({...replies, [r.id]: e.target.value})}
                    placeholder="Responda esta avaliacao publicamente..."
                    rows={2}
                    className="w-full px-3 py-2 rounded bg-white/5 border border-white/10 text-sm focus:border-magenta focus:outline-none" />
                  <button onClick={() => reply(r.id)} disabled={loading || !replies[r.id]?.trim()}
                    className="btn-primary text-xs flex items-center gap-1 disabled:opacity-50">
                    <Send className="w-3 h-3" /> Responder
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
