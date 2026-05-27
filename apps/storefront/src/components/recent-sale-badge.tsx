import { Flame, Clock } from 'lucide-react';

/**
 * MLB-NEW WORKER 16: badge de venda recente. Mercado Livre exibe
 * "Vendido hoje" / "Vendido esta semana" para criar urgencia + social proof.
 *
 * Threshold:
 *  - <= 24h -> "Vendido hoje" (flame icon laranja)
 *  - <= 7d -> "Vendido esta semana" (flame icon amarelo)
 *  - <= 30d -> "Vendido este mes" (clock icon discreto)
 *  - > 30d ou null -> nao renderiza (gracioso)
 *
 * Server Component puro (zero JS bundle).
 */
export function RecentSaleBadge({
  lastSaleAt,
  variant = 'card',
}: {
  lastSaleAt: string | Date | null | undefined;
  variant?: 'pdp' | 'card';
}) {
  if (!lastSaleAt) return null;
  const dt = typeof lastSaleAt === 'string' ? new Date(lastSaleAt) : lastSaleAt;
  if (isNaN(dt.getTime())) return null;
  const hoursAgo = (Date.now() - dt.getTime()) / 3_600_000;
  if (hoursAgo < 0 || hoursAgo > 24 * 30) return null;

  let label: string;
  let cls: string;
  let Icon = Flame;
  if (hoursAgo <= 24) {
    label = 'Vendido hoje';
    cls = 'bg-orange-500/20 text-orange-300 border-orange-500/30';
  } else if (hoursAgo <= 24 * 7) {
    label = 'Vendido esta semana';
    cls = 'bg-yellow-500/15 text-yellow-300 border-yellow-500/25';
  } else {
    label = 'Vendido este mes';
    cls = 'bg-white/5 text-white/60 border-white/10';
    Icon = Clock;
  }

  if (variant === 'card') {
    return (
      <div className={`absolute bottom-2 left-2 z-10 inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold border backdrop-blur ${cls}`}>
        <Icon className="w-2.5 h-2.5" /> {label}
      </div>
    );
  }
  return (
    <div className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-semibold border mb-4 ml-2 ${cls}`}>
      <Icon className="w-3 h-3" /> {label}
    </div>
  );
}
