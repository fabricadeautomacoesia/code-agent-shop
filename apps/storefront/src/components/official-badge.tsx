import { Award, Crown, TrendingUp } from 'lucide-react';

/**
 * MLB-NEW WORKER 16: combo selo "OFICIAL MAIS VENDIDO" estilo Mercado Livre.
 *
 * Mercado Livre tem 3 tiers de social proof:
 * 1) Apenas oficial -> badge magenta com Award
 * 2) Apenas mais vendido -> badge amarelo/laranja com TrendingUp
 * 3) AMBOS -> combo selo dourado/magenta especial (maior conversao MLB)
 *
 * Server Component puro (zero JS bundle adicional).
 */
export function OfficialBadge({
  isPlatformOwned,
  isTopSeller,
  variant = 'pdp',
}: {
  isPlatformOwned?: boolean;
  isTopSeller?: boolean;
  variant?: 'pdp' | 'card';
}) {
  if (!isPlatformOwned && !isTopSeller) return null;

  // Combo: ambos -> selo especial dourado com Crown
  if (isPlatformOwned && isTopSeller) {
    if (variant === 'card') {
      return (
        <div className="absolute top-3 left-3 inline-flex items-center gap-1 px-2.5 py-1 rounded-md
          bg-gradient-to-r from-yellow-400 via-amber-500 to-magenta
          text-black text-[10px] font-bold uppercase tracking-wide shadow-lg shadow-amber-500/40">
          <Crown className="w-3 h-3" /> Oficial mais vendido
        </div>
      );
    }
    return (
      <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full
        bg-gradient-to-r from-yellow-400 via-amber-500 to-magenta
        text-black text-xs font-bold uppercase tracking-wider shadow-lg shadow-amber-500/40 mb-4">
        <Crown className="w-3.5 h-3.5" /> Oficial mais vendido
      </div>
    );
  }

  // Apenas oficial
  if (isPlatformOwned) {
    if (variant === 'card') {
      return (
        // FIX-WORKER-16: posicao trocada de top-right -> top-left para liberar
        // top-right para Heart icon (Wishlist overlay padrao Mercado Livre).
        <div className="absolute top-3 left-3 px-2 py-1 rounded-md bg-magenta/90 text-white text-xs font-semibold flex items-center gap-1">
          <Award className="w-3 h-3" /> Oficial
        </div>
      );
    }
    return (
      <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-magenta/20 text-magenta-glow text-xs font-semibold mb-4">
        <Award className="w-3 h-3" /> Produto Oficial CAS
      </div>
    );
  }

  // Apenas mais vendido (so PDP - no card e overlay separado)
  if (variant === 'pdp') {
    return (
      <div className="inline-flex items-center gap-2 px-3 py-1 rounded-md bg-gradient-to-r from-yellow-400 to-orange-500 text-black text-xs font-bold mb-4">
        <TrendingUp className="w-3 h-3" /> Mais vendido
      </div>
    );
  }
  return null;
}
