'use client';

import { GitCompare, Check } from 'lucide-react';
import { useCompare, COMPARE_MAX, type CompareItem } from '@/lib/store';

/**
 * MLB-NEW WORKER 16: botao toggle de comparacao.
 * Variants:
 *  - pdp: botao largura cheia abaixo do CTA, glass com border
 *  - card: icone pequeno absolute no canto do card
 *
 * Click toggle: adiciona/remove do useCompare store (persistido em localStorage).
 * Maximo COMPARE_MAX=4. Se ja no max e tenta adicionar, no-op silencioso (UX MLB).
 */
export function CompareButton({
  product,
  variant = 'pdp',
}: {
  product: CompareItem;
  variant?: 'pdp' | 'card';
}) {
  const { items, toggle } = useCompare();
  const selected = items.some((i) => i.id === product.id);
  const full = !selected && items.length >= COMPARE_MAX;

  const handle = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (full) return;
    toggle(product);
  };

  if (variant === 'card') {
    return (
      <button
        onClick={handle}
        aria-label={selected ? 'Remover da comparacao' : 'Adicionar a comparacao'}
        title={full ? `Limite ${COMPARE_MAX} produtos` : (selected ? 'Remover' : 'Comparar')}
        className={`absolute bottom-2 right-2 z-10 p-1.5 rounded-lg backdrop-blur transition-all ${
          selected
            ? 'bg-magenta text-white shadow-lg shadow-magenta/40'
            : full
              ? 'bg-white/5 text-white/30 cursor-not-allowed'
              : 'bg-black/40 text-white/70 hover:bg-magenta/80 hover:text-white'
        }`}
      >
        {selected ? <Check className="w-3.5 h-3.5" /> : <GitCompare className="w-3.5 h-3.5" />}
      </button>
    );
  }

  return (
    <button
      onClick={handle}
      disabled={full}
      aria-label={selected ? 'Remover da comparacao' : 'Adicionar a comparacao'}
      className={`w-full mt-3 px-4 py-2.5 rounded-xl text-sm font-medium border transition-colors flex items-center justify-center gap-2 ${
        selected
          ? 'bg-magenta/20 border-magenta text-magenta-glow'
          : full
            ? 'bg-white/5 border-white/10 text-white/30 cursor-not-allowed'
            : 'border-white/15 bg-white/5 hover:bg-white/10 hover:border-white/25'
      }`}
    >
      {selected ? <Check className="w-4 h-4" /> : <GitCompare className="w-4 h-4" />}
      {selected ? 'Adicionado a comparacao' : full ? `Limite de ${COMPARE_MAX} atingido` : 'Adicionar a comparacao'}
    </button>
  );
}
