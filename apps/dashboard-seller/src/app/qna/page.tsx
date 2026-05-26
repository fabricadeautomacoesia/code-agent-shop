'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { sellerFetch, fmtDate } from '@/lib/seller-api';
import { MessageCircle, Send, CheckCircle, ExternalLink } from 'lucide-react';

export default function SellerQnaPage() {
  const [qna, setQna] = useState<any[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  async function load() {
    try {
      const r = await sellerFetch<{ qna: any[] }>('/qna/seller/pending');
      setQna(r.qna || []);
    } catch (e: any) { setErr(e.message); }
  }
  useEffect(() => { load(); }, []);

  async function reply(id: string) {
    const ans = answers[id];
    if (!ans || ans.trim().length < 1) return;
    setLoading(true);
    try {
      await sellerFetch(`/qna/${id}/answer`, {
        method: 'POST', body: JSON.stringify({ answer: ans.trim() })
      });
      load();
      setAnswers((p) => ({ ...p, [id]: '' }));
    } catch (e: any) { alert('Erro: ' + e.message); }
    finally { setLoading(false); }
  }

  return (
    <div>
      <h1 className="font-display font-bold text-4xl mb-2">Q&A pendente</h1>
      <p className="text-white/60 mb-8">
        Responda perguntas dos clientes em ate 24h para manter sua reputacao alta
      </p>

      {err && <div className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg mb-4">{err}</div>}

      {qna.length === 0 ? (
        <div className="glass p-12 text-center">
          <CheckCircle className="w-16 h-16 mx-auto mb-4 text-green-400" />
          <p className="text-xl mb-2">Nenhuma pergunta pendente!</p>
          <p className="text-sm text-white/60">Seus clientes nao tem duvidas no momento.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {qna.map((q) => (
            <div key={q.id} className="glass p-5">
              <div className="flex items-start gap-4 mb-4">
                {q.cover_image_url && (
                  <img src={q.cover_image_url} alt="" className="w-14 h-14 object-cover rounded" />
                )}
                <div className="flex-1">
                  <Link href={`/products/${q.product_id}`} className="text-sm font-display font-semibold hover:text-magenta flex items-center gap-1">
                    {q.product_title} <ExternalLink className="w-3 h-3" />
                  </Link>
                  <div className="text-xs text-white/40 mt-1">
                    {q.asker_name || q.asker_email || 'Cliente anonimo'} - {fmtDate(q.asked_at)}
                  </div>
                </div>
              </div>

              <div className="bg-white/5 rounded-lg p-3 mb-3">
                <div className="text-xs text-white/40 uppercase mb-1 flex items-center gap-1">
                  <MessageCircle className="w-3 h-3" /> Pergunta
                </div>
                <p className="text-sm">{q.question}</p>
              </div>

              <div className="space-y-2">
                <textarea
                  value={answers[q.id] || ''}
                  onChange={(e) => setAnswers((p) => ({ ...p, [q.id]: e.target.value }))}
                  placeholder="Sua resposta..."
                  rows={3}
                  className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus:border-magenta focus:outline-none text-sm" />
                <button
                  onClick={() => reply(q.id)}
                  disabled={loading || !(answers[q.id]?.trim())}
                  className="btn-primary text-sm flex items-center gap-2 disabled:opacity-50">
                  <Send className="w-4 h-4" /> {loading ? 'Enviando...' : 'Responder'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
