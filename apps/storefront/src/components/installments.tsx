import { CreditCard } from 'lucide-react';
import { Api } from '@/lib/api';

/**
 * MLB-NEW WORKER 17: Exibicao de parcelamento sem juros (Mercado Credito style).
 * Mercado Livre exibe "em ate 12x de R$ X,XX sem juros" abaixo de toda etiqueta
 * de preco. Esta e a feature mais cintada (cited) por compradores para conversao.
 *
 * Regra Inovare: max 12x, parcela minima R$5. Cards: variant=card (compact).
 * PDP: variant=pdp (com icone e destaque verde "sem juros").
 *
 * Server Component puro (zero JS bundle adicional).
 */
export function Installments({
  priceCents,
  isFree,
  variant = 'pdp',
}: {
  priceCents: number;
  isFree?: boolean;
  variant?: 'pdp' | 'card';
}) {
  if (isFree) return null;
  const inst = Api.installments(priceCents);
  if (!inst) return null;

  if (variant === 'card') {
    return (
      <div className="text-[10px] text-green-300/90 font-medium leading-tight mt-0.5">
        ate {inst.n}x {Api.formatBRL(inst.perCents)} <span className="text-green-300">sem juros</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 text-xs text-green-300 -mt-3 mb-5">
      <CreditCard className="w-3.5 h-3.5" />
      <span>
        em ate <strong className="text-green-200">{inst.n}x de {Api.formatBRL(inst.perCents)}</strong>
        <span className="text-green-300/80"> sem juros</span>
      </span>
    </div>
  );
}
