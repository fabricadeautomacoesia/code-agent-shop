'use client';

import { useState, useRef, KeyboardEvent } from 'react';
import { Star } from 'lucide-react';
import { QnaForm } from './qna-form';
import { QnaUpvote } from './qna-upvote';

type Tab = 'overview' | 'requirements' | 'changelog' | 'reviews' | 'qna';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview',     label: 'Visao Geral' },
  { id: 'requirements', label: 'Pre-requisitos' },
  { id: 'changelog',    label: 'Changelog' },
  { id: 'reviews',      label: 'Reviews' },
  { id: 'qna',          label: 'Q&A' },
];

interface Props {
  product: any;
  reviews: any[];
  qna: any[];
}

export function ProductTabs({ product, reviews, qna }: Props) {
  const [active, setActive] = useState<Tab>('overview');
  // FIX-WORKER-3 pass 5: refs para keyboard navigation roving tabindex (WAI-ARIA tabs)
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({} as any);

  const reviewCount = reviews?.length || 0;
  const qnaCount    = qna?.length || 0;

  // FIX-WORKER-3 pass 5: keyboard arrow nav (Left/Right/Home/End) padrao WAI-ARIA tabs
  // Antes: so Tab key passava entre botoes (foco linear). Agora arrow keys movem
  // entre tabs sem deixar o tablist - padrao acessibilidade tab interface.
  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>, currentIdx: number) {
    let nextIdx: number | null = null;
    if (e.key === 'ArrowRight') nextIdx = (currentIdx + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') nextIdx = (currentIdx - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') nextIdx = 0;
    else if (e.key === 'End') nextIdx = TABS.length - 1;
    if (nextIdx !== null) {
      e.preventDefault();
      const nextTab = TABS[nextIdx].id;
      setActive(nextTab);
      tabRefs.current[nextTab]?.focus();
    }
  }

  return (
    <div className="glass p-6">
      {/* FIX-WORKER-3 pass 5: WAI-ARIA tabs - role="tablist" + role="tab" + aria-selected + aria-controls
          Antes: <div><button> sem semantica. Screen reader anunciava como botoes soltos.
          Agora: NVDA/JAWS anuncia "Tab 1 de 5 selecionado, Visao Geral" + Left/Right move. */}
      <div role="tablist" aria-label="Detalhes do produto"
        className="flex border-b border-white/10 -mx-6 px-6 mb-6 overflow-x-auto">
        {TABS.map((t, idx) => {
          const isActive = t.id === active;
          const badge = t.id === 'reviews' ? reviewCount
                      : t.id === 'qna'     ? qnaCount
                      : null;
          return (
            <button key={t.id}
              type="button"
              ref={(el) => { tabRefs.current[t.id] = el; }}
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={isActive}
              aria-controls={`panel-${t.id}`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => setActive(t.id)}
              onKeyDown={(e) => handleKeyDown(e, idx)}
              className={`px-4 py-3 text-sm font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-magenta ${
                isActive
                  ? 'text-magenta border-b-2 border-magenta -mb-px'
                  : 'text-white/60 hover:text-white'
              }`}>
              {t.label}
              {badge !== null && badge > 0 && (
                /* FIX-WORKER-3 pass 232 (a11y plural): singular/plural correto p/ screen readers.
                   PRE-FIX: badge=1 lia "1 avaliacoes" (plural errado). PT-BR: 1 -> singular,
                   >1 -> plural. NVDA/JAWS anunciava errado a contagem. */
                <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-white/10"
                  aria-label={`${badge} ${
                    t.id === 'reviews'
                      ? (badge === 1 ? 'avaliacao' : 'avaliacoes')
                      : (badge === 1 ? 'pergunta' : 'perguntas')
                  }`}>{badge}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* OVERVIEW - FIX-WORKER-3 pass 5: role=tabpanel + labelledby p/ WAI-ARIA tabs */}
      {active === 'overview' && (
        <div role="tabpanel" id="panel-overview" aria-labelledby="tab-overview" className="prose prose-invert max-w-none">
          <h3 className="font-display text-2xl mt-0">Sobre este produto</h3>
          <p className="whitespace-pre-line text-white/80">{product.description}</p>
          {product.tech_stack?.length > 0 && (
            <>
              <h3 className="font-display text-xl mt-6">Tech stack</h3>
              <div className="flex flex-wrap gap-1.5 not-prose">
                {product.tech_stack.map((t: string) => (
                  <span key={t} className="text-xs px-2 py-1 rounded bg-white/5 font-mono">{t}</span>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* REQUIREMENTS */}
      {active === 'requirements' && (
        <div role="tabpanel" id="panel-requirements" aria-labelledby="tab-requirements" className="prose prose-invert max-w-none">
          <h3 className="font-display text-2xl mt-0">Pre-requisitos</h3>
          {product.install_instructions ? (
            <>
              <h4 className="font-display text-base">Instrucoes de instalacao</h4>
              <pre className="bg-black/40 p-4 rounded-lg overflow-x-auto text-sm not-prose">{product.install_instructions}</pre>
            </>
          ) : (
            <p className="text-white/60">Sem instrucoes de instalacao especificas.</p>
          )}
          {product.api_keys_required?.length > 0 && (
            <>
              <h4 className="font-display text-base mt-4">APIs necessarias</h4>
              <ul className="not-prose space-y-1">
                {product.api_keys_required.map((k: string) => (
                  <li key={k}><code className="text-xs px-2 py-1 rounded bg-white/5">{k}</code></li>
                ))}
              </ul>
            </>
          )}
          {product.estimated_install_min && (
            <p className="text-white/60 text-sm mt-4">
              Tempo estimado de instalacao: <strong className="text-white">{product.estimated_install_min} minutos</strong>
            </p>
          )}
        </div>
      )}

      {/* CHANGELOG */}
      {active === 'changelog' && (
        <div role="tabpanel" id="panel-changelog" aria-labelledby="tab-changelog" className="prose prose-invert max-w-none">
          <h3 className="font-display text-2xl mt-0">Changelog</h3>
          {product.versions?.length > 0 ? (
            <div className="not-prose space-y-3">
              {/* FIX-WORKER-3 pass 5: ordem DESC garantida (mais recente primeiro).
                  Backend pode retornar em qualquer ordem - aqui forcamos by created_at DESC. */}
              {[...product.versions].sort((a: any, b: any) =>
                new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
              ).map((v: any) => (
                <div key={v.id} className="border-l-2 border-magenta pl-3">
                  <div className="font-mono text-sm font-bold">v{v.version}</div>
                  <div className="text-xs text-white/40 mb-1">{new Date(v.created_at).toLocaleDateString('pt-BR')}</div>
                  <div className="text-sm text-white/70 whitespace-pre-line">{v.changelog}</div>
                  {v.breaking_changes && (
                    <div className="text-xs text-orange-300 mt-1">Breaking changes!</div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-white/60 text-sm">Versao inicial do produto. Sem changelog ainda.</p>
          )}
        </div>
      )}

      {/* REVIEWS */}
      {active === 'reviews' && (
        <div role="tabpanel" id="panel-reviews" aria-labelledby="tab-reviews">
          <h3 className="font-display font-bold text-2xl mb-4">Avaliacoes {reviewCount > 0 && `(${reviewCount})`}</h3>
          {reviewCount === 0 ? (
            <p className="text-sm text-white/60">Ainda sem avaliacoes. Compre e seja o primeiro a avaliar.</p>
          ) : (
            <div className="space-y-4">
              {reviews.map((r: any) => (
                <div key={r.id} className="border-b border-white/5 pb-4 last:border-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    {/* FIX-WORKER-3: 5 estrelas sempre (preenchidas vs vazias estilo MLB) em vez de N estrelas */}
                    {/* FIX-WORKER-3 pass 5: aria-hidden em estrelas decorativas (so o container aria-label conta) */}
                    <div className="flex items-center gap-0.5" role="img" aria-label={`${r.rating} de 5 estrelas`}>
                      {Array.from({ length: 5 }).map((_, i) => (
                        <Star key={i} aria-hidden="true" className={`w-4 h-4 ${
                          i < r.rating ? 'fill-yellow-400 text-yellow-400' : 'fill-white/10 text-white/20'
                        }`} />
                      ))}
                    </div>
                    <span className="font-semibold text-sm">{r.title}</span>
                    {r.is_verified_purchase && (
                      <span className="text-[10px] px-1.5 py-0.5 bg-green-500/20 text-green-400 rounded">COMPRA VERIFICADA</span>
                    )}
                  </div>
                  <p className="text-sm text-white/70">{r.body}</p>
                  <div className="flex items-center gap-2 text-xs text-white/40 mt-1">
                    {/* FIX-WORKER-3: fallback "Usuario CAS" quando user sem display_name */}
                    <span>{r.buyer_name || 'Usuario CAS'}</span>
                    <span>-</span>
                    {/* FIX-WORKER-3 pass 254 (defensive date render):
                        PRE-FIX: new Date(r.created_at).toLocaleDateString sem guard
                        - r.created_at=null -> new Date(null) -> "01/01/1970"
                        - r.created_at=undefined -> "Invalid Date" literal
                        Edge case raro (backend deveria garantir NOT NULL) mas defesa
                        em camada. Pattern V8: render '-' se data invalida. */}
                    <span>{r.created_at && !isNaN(new Date(r.created_at).getTime())
                      ? new Date(r.created_at).toLocaleDateString('pt-BR')
                      : '-'}</span>
                    {Number(r.helpful_count) > 0 && (
                      <>
                        <span>-</span>
                        <span className="text-green-400">{r.helpful_count} util</span>
                      </>
                    )}
                  </div>
                  {/* FIX-WORKER-3: resposta do vendedor expandido (era ignorado no payload) */}
                  {r.reply_from_seller && (
                    <div className="mt-2 ml-3 pl-3 border-l-2 border-magenta">
                      <div className="text-[10px] uppercase text-magenta-glow font-bold mb-1">Resposta do vendedor</div>
                      <p className="text-xs text-white/70 whitespace-pre-line">{r.reply_from_seller}</p>
                      {r.reply_at && (
                        <div className="text-[10px] text-white/30 mt-1">
                          {new Date(r.reply_at).toLocaleDateString('pt-BR')}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Q&A */}
      {active === 'qna' && (
        <div role="tabpanel" id="panel-qna" aria-labelledby="tab-qna">
          <h3 className="font-display font-bold text-2xl mb-4">Perguntas & Respostas {qnaCount > 0 && `(${qnaCount})`}</h3>
          {qnaCount === 0 ? (
            <p className="text-sm text-white/60 mb-6">Seja o primeiro a perguntar sobre este produto.</p>
          ) : (
            <div className="space-y-4 mb-6">
              {qna.map((q: any) => (
                <div key={q.id} className="border-b border-white/5 pb-4 last:border-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1">
                      <div className="font-semibold text-sm mb-1">Q: {q.question}</div>
                      {q.answer
                        ? <div className="text-sm text-white/70 pl-4 border-l-2 border-magenta mt-1">R: {q.answer}</div>
                        : <div className="text-xs text-white/40 italic mt-1">Aguardando resposta do vendedor...</div>}
                    </div>
                    <QnaUpvote qnaId={q.id} initialCount={q.upvote_count || 0} />
                  </div>
                </div>
              ))}
            </div>
          )}
          <QnaForm productId={product.id} />
        </div>
      )}
    </div>
  );
}
