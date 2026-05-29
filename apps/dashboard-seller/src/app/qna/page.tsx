'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { sellerFetch, fmtDate } from '@/lib/seller-api';
import { useSellerAction } from '@/lib/use-seller-action';
import { MessageCircle, Send, CheckCircle, ExternalLink } from 'lucide-react';

// FIX-WORKER-5 pass 425: storefront URL env-driven (paridade W6 pass 397 auth-svc)
// Build-time NEXT_PUBLIC_STOREFRONT_URL ou fallback prod cas.inovareinteligenciaartificial.com
const STOREFRONT_URL = (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_STOREFRONT_URL)
  || 'https://cas.inovareinteligenciaartificial.com';

export default function SellerQnaPage() {
  const [qna, setQna] = useState<any[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState('');

  /* FIX-WORKER-5 pass 748 (useCallback stable closure - cadeia 11 sites):
     PRE-FIX BUG: async function load() recriada cada render.
     - useSellerAction(load) recebe nova ref cada render -> action.run re-criada
     - SLA-critical: seller responses QnA tem 24h deadline (notificacoes + UX)
     - Cascading re-renders durante mutations (reply, mark-answered)
     POST-FIX (paridade cadeia 738-747):
     - useCallback wrap em load com [] deps -> stable reference
     - useSellerAction recebe stable callback -> action.run estavel
     - useEffect deps [load] - paridade ESLint exhaustive-deps
     Pattern V8 React stability cadeia 11 sites cross-dashboard. */
  const load = useCallback(async () => {
    try {
      const r = await sellerFetch<{ qna: any[] }>('/qna/seller/pending');
      setQna(r.qna || []);
      setLoadError('');
    } catch (e: any) { setLoadError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // FIX-WORKER-5 pass 2: useSellerAction hook substitui alert() browser-blocking.
  // Bonus: busyKey per-row corrige bug "loading global" (W5 pass 1 baseline)
  // Antes: clicar Responder em row A travava TODOS botoes.
  const action = useSellerAction(load);

  async function reply(id: string) {
    const ans = answers[id];
    // FIX-WORKER-5 pass 248 (silent empty input UX):
    //   PRE-FIX: if (!ans || ans.trim().length < 1) return;
    //   User clicava "Responder" com input vazio -> NADA acontecia
    //   Botao continuava enabled, sem feedback. Falsa percepcao de bug.
    //   POST-FIX: usa action.run com throw -> banner amigavel surge.
    if (!ans || ans.trim().length < 5) {
      action.run(`answer-${id}`, async () => {
        throw new Error('Resposta minima 5 caracteres - preencha o campo antes de enviar.');
      });
      return;
    }
    action.run(`answer-${id}`, async () => {
      await sellerFetch(`/qna/${id}/answer`, {
        method: 'POST', body: JSON.stringify({ answer: ans.trim() })
      });
      setAnswers((p) => ({ ...p, [id]: '' }));
      return `Resposta enviada (${id.slice(0, 8)}...)`;
    });
  }

  return (
    <div>
      <h1 className="font-display font-bold text-4xl mb-2">Q&A pendente</h1>
      <p className="text-white/60 mb-8">
        Responda perguntas dos clientes em ate 24h para manter sua reputacao alta
      </p>

      {/* FIX-WORKER-5 pass 248 (a11y parity): loadError sem role=alert
          enquanto action.error/success ja tem - padronizado (pattern V8). */}
      {loadError && (
        <div role="alert" className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg mb-4">
          Erro carregando lista: {loadError}
        </div>
      )}

      {/* FIX-WORKER-5 pass 2 + 172 (a11y V8 R23) */}
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

      {qna.length === 0 ? (
        /* FIX-WORKER-5 pass 544 (a11y consolidation): CheckCircle empty state icon
           decorativo precisa aria-hidden. Paridade pass 541 PDP + cadeia W3 a11y
           (icons decorativos com texto descritivo no mesmo container = aria-hidden).
           role=status p/ SR announce "Nenhuma pergunta pendente" no zero-state. */
        <div role="status" className="glass p-12 text-center">
          <CheckCircle className="w-16 h-16 mx-auto mb-4 text-green-400" aria-hidden="true" />
          <p className="text-xl mb-2">Nenhuma pergunta pendente!</p>
          <p className="text-sm text-white/60">Seus clientes nao tem duvidas no momento.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {qna.map((q) => {
            const busy = action.busyKey === `answer-${q.id}`;
            return (
              <div key={q.id} className="glass p-5">
                {/* FIX-WORKER-5 pass 425: link unico /products/{product_id} so abria
                    o edit-page seller (UX confuso quando seller quer VER a pergunta no
                    contexto PDP publico). Backend response (review-svc /qna/seller/pending
                    linha 813) ja envia product_slug - usar p/ link storefront publico.
                    PRE-FIX: 1 link interno apenas (edit page)
                    POST-FIX: 2 links separados:
                    - Title -> dashboard-seller /products/{id} (edit)
                    - Botao "Ver no site" -> storefront publico /product/{slug}#qna-{id}
                    Hash anchor #qna-{id} permite jump direto a pergunta na PDP. */}
                <div className="flex items-start gap-4 mb-4">
                  {/* FIX-WORKER-5 pass 544 (perf - paridade pass 4 compare-drawer):
                      <img> raw -> Next.js <Image> com sizes='56px' + loading='lazy'.
                      Sem sizes Next.js servia full-resolution product cover image
                      para thumb 56x56 = waste bandwidth + LCP penalty.
                      Lazy nao bloqueia render inicial (lista pode ter 20+ qnas
                      pendente). alt="" decorativo (titulo proximo eh accessible name). */}
                  {q.cover_image_url && (
                    <Image src={q.cover_image_url} alt="" width={56} height={56}
                      sizes="56px" loading="lazy"
                      className="w-14 h-14 object-cover rounded" />
                  )}
                  <div className="flex-1">
                    <Link href={`/products/${q.product_id}`} className="text-sm font-display font-semibold hover:text-magenta flex items-center gap-1">
                      {q.product_title} <ExternalLink className="w-3 h-3" aria-hidden="true" />
                    </Link>
                    <div className="text-xs text-white/40 mt-1 flex items-center gap-2">
                      <span>{q.asker_name || q.asker_email || 'Cliente anonimo'} - {fmtDate(q.asked_at)}</span>
                      {q.product_slug && (
                        <a href={`${STOREFRONT_URL}/product/${q.product_slug}#qna-${q.id}`}
                          target="_blank" rel="noopener noreferrer"
                          aria-label={`Ver pergunta no site publico: ${q.product_title}`}
                          className="inline-flex items-center gap-1 text-magenta hover:underline">
                          Ver no site <ExternalLink className="w-3 h-3" aria-hidden="true" />
                        </a>
                      )}
                    </div>
                  </div>
                </div>

                <div className="bg-white/5 rounded-lg p-3 mb-3">
                  {/* FIX-WORKER-5 pass 544 (a11y): MessageCircle icon decorativo
                      precisa aria-hidden (paridade pass 541 PDP cadeia W3 a11y). */}
                  <div className="text-xs text-white/40 uppercase mb-1 flex items-center gap-1">
                    <MessageCircle className="w-3 h-3" aria-hidden="true" /> Pergunta
                  </div>
                  <p className="text-sm">{q.question}</p>
                </div>

                <div className="space-y-2">
                  {/* FIX-WORKER-5 pass 147 (a11y): aria-label dinamico identifica
                      qual pergunta cada textarea responde (multiplos forms no DOM).
                      htmlFor/id seria impraticavel - 1 textarea por question dinamica. */}
                  {/* FIX-WORKER-5 pass 331: maxLength + counter UX paridade pass 330 reviews.
                      Backend Zod max 5000 (review-svc linha 806). HTML5 blocks typing > limit. */}
                  <textarea
                    value={answers[q.id] || ''}
                    onChange={(e) => setAnswers((p) => ({ ...p, [q.id]: e.target.value }))}
                    placeholder="Sua resposta..."
                    rows={3}
                    maxLength={5000}
                    disabled={busy}
                    aria-label={`Resposta para pergunta: ${q.question.slice(0, 60)}${q.question.length > 60 ? '...' : ''}`}
                    aria-describedby={`answer-counter-${q.id}`}
                    className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus:border-magenta focus:outline-none text-sm disabled:opacity-50" />
                  <div id={`answer-counter-${q.id}`} aria-live="polite"
                    className={`text-[10px] text-right ${
                      (answers[q.id]?.length || 0) > 4750 ? 'text-yellow-400' : 'text-white/30'
                    }`}>
                    {answers[q.id]?.length || 0}/5000
                  </div>
                  <button
                    type="button"
                    onClick={() => reply(q.id)}
                    disabled={busy || !(answers[q.id]?.trim())}
                    aria-label={`Enviar resposta para: ${q.question.slice(0, 40)}${q.question.length > 40 ? '...' : ''}`}
                    className="btn-primary text-sm flex items-center gap-2 disabled:opacity-50 disabled:cursor-wait">
                    <Send className="w-4 h-4" aria-hidden="true" /> {busy ? 'Enviando...' : 'Responder'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
