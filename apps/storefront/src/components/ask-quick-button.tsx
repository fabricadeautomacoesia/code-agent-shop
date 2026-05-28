'use client';

import { useState } from 'react';
import { MessageCircle, X } from 'lucide-react';
import { QnaForm } from './qna-form';
import { Dialog } from './dialog';

/**
 * MLB-NEW: Botao 'Tenho duvida' prominente no PDP ao lado do CTA Comprar.
 * Mercado Livre mostra atalho 'Fazer pergunta' no funil de compra para
 * reduzir abandono por incerteza tecnica.
 *
 * FIX-WORKER-3 pass 11: REFATORADO para usar <Dialog> wrapper (pass 9).
 *
 * REMOVIDO ~30 linhas pre-fix:
 * - useEffect manual Escape listener + body scroll lock + focus management
 * - useRef triggerRef + modalRef + closeBtnRef (3 refs manuais)
 * - <div outer> + <div backdrop aria-hidden> + onClick stopPropagation manual
 * - role="dialog" + aria-modal + aria-labelledby manual
 *
 * Pos-fix: Dialog declara open/close lifecycle.
 * BONUS pass 9: focus auto-mount + return-to-opener INCLUIDO no wrapper
 * (pre-fix tinha manualmente via useRef - agora gratuito).
 *
 * z-index 80 mantido (modal acima cart-drawer z-60).
 * variant='centered' (modal no centro da viewport).
 * hideCloseButton=true: tem header rico custom (icon + title + subtitle hint).
 */
export function AskQuickButton({ productId }: { productId: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* FIX-WORKER-3 pass 159 (a11y): type='button' defensive */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full mt-3 px-4 py-2.5 rounded-xl text-sm font-medium border border-white/15 bg-white/5 hover:bg-magenta/10 hover:border-magenta/40 transition-colors flex items-center justify-center gap-2 group focus-visible:outline-2 focus-visible:outline-magenta"
        aria-label="Fazer pergunta sobre este produto"
      >
        <MessageCircle className="w-4 h-4 text-magenta group-hover:scale-110 transition-transform" aria-hidden="true" />
        Tem alguma duvida? <span className="text-magenta font-semibold">Pergunte ao vendedor</span>
      </button>

      {/* Dialog SEM title prop: header rico (icon + h3 visivel + subtitle)
          renderizado dentro do children como JSX custom. ariaLabel cobre
          screen reader (evita double-announce com h2 sr-only do Dialog). */}
      {/* FIX-WORKER-3 pass 300 (a11y duplicate label disambiguation):
          PRE-FIX: backdrop button (Dialog wrapper) e X custom (linha abaixo)
          ambos com aria-label='Fechar modal'. Screen reader anuncia 2x botoes
          identicos - confuso para NVDA/JAWS user navegando por tab/landmark.
          POST-FIX: closeLabel='Fechar clicando fora' p/ backdrop (semantica
          area maior) + X custom mantem 'Fechar modal' (acao explicita). */}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        ariaLabel="Pergunta ao vendedor"
        variant="centered"
        zIndex={80}
        closeLabel="Fechar clicando fora"
        className="relative glass-strong rounded-2xl p-6 max-w-md w-full shadow-2xl"
      >
        <button type="button" onClick={() => setOpen(false)} aria-label="Fechar modal de pergunta"
          className="absolute top-3 right-3 p-1.5 rounded-lg hover:bg-white/5 transition-colors focus-visible:outline-2 focus-visible:outline-magenta">
          <X className="w-5 h-5" aria-hidden="true" />
        </button>
        <h3 className="font-display font-bold text-xl mb-1 flex items-center gap-2">
          <MessageCircle className="w-5 h-5 text-magenta" aria-hidden="true" /> Pergunta ao vendedor
        </h3>
        <p className="text-xs text-white/50 mb-4">
          Respondida tipicamente em ate 48h. Sua pergunta sera publica para outros compradores.
        </p>
        <QnaForm productId={productId} onSubmitted={() => setTimeout(() => setOpen(false), 1500)} />
      </Dialog>
    </>
  );
}
