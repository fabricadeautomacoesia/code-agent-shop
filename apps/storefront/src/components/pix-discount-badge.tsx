import { Zap } from 'lucide-react';
import { Api } from '@/lib/api';

/**
 * MLB-16 WORKER 16 pass 167: badge "Desconto PIX -5%"
 *
 * Pattern Mercado Livre / e-commerces brasileiros: PIX paga menos.
 * Constante PIX_DISCOUNT_PCT = 0.05 (5%) consistente com backend.
 *
 * Renderiza preco discount alongside preco regular:
 *   R$ 199,90 ou R$ 189,90 via PIX (-5%)
 *
 * Variants:
 * - 'pdp': inline destacado abaixo do preco principal
 * - 'card': mini badge (so percentual, sem valor)
 *
 * Server Component puro (zero JS bundle).
 * Backend ja suporta via /api/payments/asaas/create billingType=PIX
 * (futuramente aplicar discount via metadata + reconcile order_total).
 */

const PIX_DISCOUNT_PCT = 0.05; // 5% - alinhar com backend payment-svc

export function PixDiscountBadge({
  priceCents,
  isFree,
  variant = 'pdp',
}: {
  priceCents: number;
  isFree?: boolean;
  variant?: 'pdp' | 'card';
}) {
  if (isFree || !priceCents || priceCents < 100) return null;

  const discountCents = Math.floor(priceCents * PIX_DISCOUNT_PCT);
  const finalCents = priceCents - discountCents;

  if (variant === 'card') {
    // Card mini badge - so percentual
    return (
      <div
        aria-label={`Desconto de ${Math.round(PIX_DISCOUNT_PCT * 100)}% pagando via PIX`}
        className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-green-500/15 border border-green-500/30 text-green-300 text-[10px] font-bold uppercase"
      >
        <Zap className="w-2.5 h-2.5 fill-green-300" aria-hidden="true" />
        PIX -{Math.round(PIX_DISCOUNT_PCT * 100)}%
      </div>
    );
  }

  // PDP variant - destaque com valor calculado
  return (
    <div
      aria-label={`Pagando via PIX: ${Api.formatBRL(finalCents)} (economia de ${Api.formatBRL(discountCents)})`}
      className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-gradient-to-r from-green-500/10 to-emerald-500/10 border border-green-500/30"
    >
      <Zap className="w-4 h-4 fill-green-400 text-green-400 flex-shrink-0" aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <div className="text-xs text-green-300 font-semibold flex items-center gap-1.5">
          ou {Api.formatBRL(finalCents)}{' '}
          <span className="text-[10px] font-normal text-green-400/70">via PIX (-{Math.round(PIX_DISCOUNT_PCT * 100)}%)</span>
        </div>
        <div className="text-[10px] text-white/50">
          Economia de {Api.formatBRL(discountCents)} - aprovacao instantanea
        </div>
      </div>
    </div>
  );
}
