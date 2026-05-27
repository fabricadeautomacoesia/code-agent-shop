'use client';

import Link from 'next/link';
import { GitCompare, Check, ArrowRight } from 'lucide-react';
import { useCompare, COMPARE_MAX, type CompareItem } from '@/lib/store';

/**
 * MLB-NEW WORKER 16: botao toggle de comparacao.
 * Variants:
 *  - pdp: botao largura cheia abaixo do CTA, glass com border
 *  - card: icone pequeno absolute no canto do card
 *
 * Click toggle: adiciona/remove do useCompare store (persistido em localStorage).
 * Maximo COMPARE_MAX=4. Se ja no max e tenta adicionar, no-op silencioso (UX MLB).
 *
 * FIX-WORKER-3 pass 11 (a11y/UX - mesmo pattern WishlistButton/PriceAlertButton):
 * - aria-pressed em ambos variants
 * - aria-hidden em icons decorativos
 * - PDP variant: ao atingir limite mostra CTA "Ver comparacao" linkando /comparar
 *   (era texto morto "Limite atingido" sem proximos passos)
 * - focus-visible outline-magenta consistente
 * - title em ambos variants (era so card)
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

  const titleText = full
    ? `Limite de ${COMPARE_MAX} produtos atingido - ver comparacao primeiro`
    : (selected ? 'Remover da comparacao' : 'Adicionar a comparacao');

  // FIX-WORKER-3 pass 5: card variant full state vira <Link> consistente com
  // PDP variant. Antes: button disabled cinza inutil (zero affordance).
  // Agora: clica e vai para /comparar (mesmo fluxo PDP full).
  if (variant === 'card' && full) {
    const compareIds = items.map((i) => i.id).join(',');
    return (
      <Link
        href={`/comparar?ids=${compareIds}`}
        onClick={(e) => e.stopPropagation()}
        aria-label="Limite atingido - ver pagina de comparacao"
        title={titleText}
        className="absolute bottom-2 right-2 z-10 p-1.5 rounded-lg backdrop-blur transition-all focus-visible:outline-2 focus-visible:outline-yellow-400 bg-yellow-500/20 text-yellow-200 hover:bg-yellow-500/30 border border-yellow-500/40"
      >
        <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
      </Link>
    );
  }

  if (variant === 'card') {
    return (
      <button
        onClick={handle}
        aria-label={titleText}
        aria-pressed={selected}
        title={titleText}
        className={`absolute bottom-2 right-2 z-10 p-1.5 rounded-lg backdrop-blur transition-all focus-visible:outline-2 focus-visible:outline-magenta ${
          selected
            ? 'bg-magenta text-white shadow-lg shadow-magenta/40'
            : 'bg-black/40 text-white/70 hover:bg-magenta/80 hover:text-white'
        }`}
      >
        {selected
          ? <Check className="w-3.5 h-3.5" aria-hidden="true" />
          : <GitCompare className="w-3.5 h-3.5" aria-hidden="true" />}
      </button>
    );
  }

  // FIX-WORKER-3 pass 11: PDP variant quando full -> CTA p/ /comparar
  // Antes: botao morto "Limite atingido" sem proximos passos.
  // Agora: Link para /comparar com ids do store, user pode ver/limpar lista.
  if (full && variant === 'pdp') {
    const compareIds = items.map((i) => i.id).join(',');
    return (
      <Link
        href={`/comparar?ids=${compareIds}`}
        aria-label="Limite atingido - ver pagina de comparacao"
        title={titleText}
        className="w-full mt-3 px-4 py-2.5 rounded-xl text-sm font-medium border border-yellow-500/40 bg-yellow-500/10 text-yellow-200 hover:bg-yellow-500/20 hover:border-yellow-500/60 transition-colors flex items-center justify-center gap-2 focus-visible:outline-2 focus-visible:outline-yellow-400"
      >
        <GitCompare className="w-4 h-4" aria-hidden="true" />
        Limite de {COMPARE_MAX} atingido - Ver comparacao
        <ArrowRight className="w-4 h-4" aria-hidden="true" />
      </Link>
    );
  }

  return (
    <button
      onClick={handle}
      aria-label={titleText}
      aria-pressed={selected}
      title={titleText}
      className={`w-full mt-3 px-4 py-2.5 rounded-xl text-sm font-medium border transition-colors flex items-center justify-center gap-2 focus-visible:outline-2 focus-visible:outline-magenta ${
        selected
          ? 'bg-magenta/20 border-magenta text-magenta-glow'
          : 'border-white/15 bg-white/5 hover:bg-white/10 hover:border-white/25'
      }`}
    >
      {selected
        ? <Check className="w-4 h-4" aria-hidden="true" />
        : <GitCompare className="w-4 h-4" aria-hidden="true" />}
      {/* FIX-WORKER-3 pass 5: texto enganoso "Adicionado" sugere read-only.
          User nao sabia que clique remove. Inconsistente com titleText linha 44
          que ja dizia "Remover da comparacao". Agora alinhado: acao explicita. */}
      {selected ? 'Remover da comparacao' : 'Adicionar a comparacao'}
    </button>
  );
}
