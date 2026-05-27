'use client';

import { useState, useEffect, useRef } from 'react';
import { MessageCircle, X } from 'lucide-react';
import { QnaForm } from './qna-form';

/**
 * MLB-NEW: Botao 'Tenho duvida' prominente no PDP ao lado do CTA Comprar.
 * Mercado Livre mostra atalho 'Fazer pergunta' no funil de compra para
 * reduzir abandono por incerteza tecnica.
 *
 * Abre modal centralizado com QnaForm pre-existente.
 * FIX-WORKER-3 pass 7 (a11y completo WCAG 2.1):
 * - role="dialog" + aria-modal + aria-labelledby
 * - Esc key fecha (era apenas click-outside)
 * - Focus trap basico (auto-focus + return to opener)
 * - body scroll lock enquanto modal aberto
 */
export function AskQuickButton({ productId }: { productId: string }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);

  // FIX-WORKER-3 pass 7: Esc fecha + body scroll lock + focus management
  useEffect(() => {
    if (!open) return;

    // 1. body scroll lock (era ausente - scroll background ativo atras do modal)
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // 2. Esc fecha (era ausente - JSDoc dizia "Esc fecha" mas codigo nao implementava)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);

    // 3. Auto-focus no modal (close btn como anchor) apos animacao
    const focusTimer = setTimeout(() => {
      closeBtnRef.current?.focus();
    }, 50);

    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener('keydown', onKey);
      clearTimeout(focusTimer);
      // 4. Return focus ao opener (acessibilidade keyboard nav)
      triggerRef.current?.focus();
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => setOpen(true)}
        className="w-full mt-3 px-4 py-2.5 rounded-xl text-sm font-medium border border-white/15 bg-white/5 hover:bg-magenta/10 hover:border-magenta/40 transition-colors flex items-center justify-center gap-2 group focus-visible:outline-2 focus-visible:outline-magenta"
        aria-label="Fazer pergunta sobre este produto"
      >
        <MessageCircle className="w-4 h-4 text-magenta group-hover:scale-110 transition-transform" aria-hidden="true" />
        Tem alguma duvida? <span className="text-magenta font-semibold">Pergunte ao vendedor</span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center p-4"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="ask-modal-title"
        >
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" aria-hidden="true" />
          <div ref={modalRef}
            className="relative glass-strong rounded-2xl p-6 max-w-md w-full shadow-2xl"
            onClick={(e) => e.stopPropagation()}>
            <button ref={closeBtnRef} onClick={() => setOpen(false)} aria-label="Fechar modal"
              className="absolute top-3 right-3 p-1.5 rounded-lg hover:bg-white/5 transition-colors focus-visible:outline-2 focus-visible:outline-magenta">
              <X className="w-5 h-5" aria-hidden="true" />
            </button>
            <h3 id="ask-modal-title"
              className="font-display font-bold text-xl mb-1 flex items-center gap-2">
              <MessageCircle className="w-5 h-5 text-magenta" aria-hidden="true" /> Pergunta ao vendedor
            </h3>
            <p className="text-xs text-white/50 mb-4">
              Respondida tipicamente em ate 48h. Sua pergunta sera publica para outros compradores.
            </p>
            <QnaForm productId={productId} onSubmitted={() => setTimeout(() => setOpen(false), 1500)} />
          </div>
        </div>
      )}
    </>
  );
}
