import { ShieldCheck, Crown } from 'lucide-react';

/**
 * MLB-17 WORKER 16 pass 169: badge "Vendedor Verificado / Lider Premium"
 *
 * Pattern Mercado Livre "Mercado Lider Premium" adaptado ao CAS.
 * Destaque visual EXTRA para sellers tier alto (trust marks):
 *
 *   - lider_platinum: "LIDER PREMIUM" (crown gold + magenta gradient)
 *   - platinum:       "VENDEDOR VERIFICADO" (shield cyan)
 *   - ouro:           (sem badge extra - tier badge ja existe)
 *
 * Trust signals (MLB psychology):
 *   - Coroa = topo da pirâmide (raro, aspiracional)
 *   - Shield = seguranca / verificacao oficial
 *
 * Variants:
 *   - 'card': mini badge inline no topo do card
 *   - 'pdp':  destaque maior abaixo do seller name
 *
 * Server Component puro (zero JS bundle).
 */

const TRUST_CONFIG: Record<
  string,
  { label: string; icon: 'crown' | 'shield'; gradient: string; ring: string; text: string }
> = {
  lider_platinum: {
    label: 'LIDER PREMIUM',
    icon: 'crown',
    gradient: 'from-yellow-400/25 via-magenta/20 to-purple-500/25',
    ring: 'border-yellow-400/40',
    text: 'text-yellow-200',
  },
  platinum: {
    label: 'VERIFICADO',
    icon: 'shield',
    gradient: 'from-cyan-400/20 to-blue-500/20',
    ring: 'border-cyan-400/40',
    text: 'text-cyan-200',
  },
};

export function VerifiedSellerBadge({
  reputationTier,
  variant = 'card',
}: {
  reputationTier?: string | null;
  variant?: 'card' | 'pdp';
}) {
  if (!reputationTier) return null;
  const config = TRUST_CONFIG[reputationTier];
  if (!config) return null;

  const Icon = config.icon === 'crown' ? Crown : ShieldCheck;

  if (variant === 'card') {
    return (
      <span
        aria-label={`Selo de confianca: ${config.label}`}
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-gradient-to-r ${config.gradient} border ${config.ring} ${config.text} text-[10px] font-bold uppercase tracking-wider shadow-sm`}
      >
        <Icon className="w-3 h-3" aria-hidden="true" />
        {config.label}
      </span>
    );
  }

  // PDP variant - destaque maior abaixo do seller name
  return (
    <div
      aria-label={`Selo de confianca: ${config.label}`}
      className={`mt-2 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gradient-to-r ${config.gradient} border ${config.ring}`}
    >
      <Icon className={`w-4 h-4 ${config.text}`} aria-hidden="true" />
      <div className="flex flex-col">
        <span className={`${config.text} text-xs font-bold uppercase tracking-wider`}>
          {config.label}
        </span>
        <span className="text-[10px] text-white/60">
          {config.icon === 'crown'
            ? 'Top da plataforma - reputacao maxima'
            : 'Seller verificado - alta reputacao'}
        </span>
      </div>
    </div>
  );
}
