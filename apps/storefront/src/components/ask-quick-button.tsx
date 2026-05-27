'use client';

import { useState } from 'react';
import { MessageCircle, X } from 'lucide-react';
import { QnaForm } from './qna-form';

/**
 * MLB-NEW: Botao 'Tenho duvida' prominente no PDP ao lado do CTA Comprar.
 * Mercado Livre mostra atalho 'Fazer pergunta' no funil de compra para
 * reduzir abandono por incerteza tecnica.
 *
 * Abre modal centralizado com QnaForm pre-existente.
 * Esc/click-outside fecha. onSubmitted -> fecha automatico.
 */
export function AskQuickButton({ productId }: { productId: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="w-full mt-3 px-4 py-2.5 rounded-xl text-sm font-medium border border-white/15 bg-white/5 hover:bg-magenta/10 hover:border-magenta/40 transition-colors flex items-center justify-center gap-2 group"
        aria-label="Fazer pergunta sobre este produto"
      >
        <MessageCircle className="w-4 h-4 text-magenta group-hover:scale-110 transition-transform" />
        Tem alguma duvida? <span className="text-magenta font-semibold">Pergunte ao vendedor</span>
      </button>

      {open && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" aria-hidden />
          <div className="relative glass-strong rounded-2xl p-6 max-w-md w-full shadow-2xl"
            onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setOpen(false)} aria-label="Fechar"
              className="absolute top-3 right-3 p-1.5 rounded-lg hover:bg-white/5 transition-colors">
              <X className="w-5 h-5" />
            </button>
            <h3 className="font-display font-bold text-xl mb-1 flex items-center gap-2">
              <MessageCircle className="w-5 h-5 text-magenta" /> Pergunta ao vendedor
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
