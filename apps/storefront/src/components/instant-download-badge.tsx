import { Zap } from 'lucide-react';

/**
 * MLB-15 WORKER 16 pass 166: badge "Download imediato"
 *
 * Pattern Mercado Livre adaptado: "Chegada hoje" (frete express)
 * -> Para produtos digitais: "Download imediato" (acesso pos-pagamento).
 *
 * Mostra confiavel visual de que produto:
 * - Tem package_url (file pronto p/ download)
 * - Eh approved (nao em QA)
 * - Sera disponibilizado em ate 60s pos-payment confirmation Asaas
 *
 * Variants:
 * - 'card': overlay no card de produto (top-left, abaixo OfficialBadge)
 * - 'pdp': inline na seccao de preco (badge maior)
 *
 * Server Component puro (zero JS bundle).
 */
export function InstantDownloadBadge({
  hasPackage,
  variant = 'card',
}: {
  hasPackage?: boolean;
  variant?: 'card' | 'pdp';
}) {
  // Renderiza apenas se produto tem package_url (pronto p/ download)
  if (!hasPackage) return null;

  if (variant === 'pdp') {
    return (
      <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-gradient-to-r from-cyan-500/20 to-blue-500/20 border border-cyan-400/30 text-cyan-300 text-xs font-semibold">
        <Zap className="w-3.5 h-3.5 fill-cyan-300" aria-hidden="true" />
        Download imediato
      </div>
    );
  }

  // Card variant: badge compacto bottom-right (acima do RecentSale se ambos)
  return (
    <div
      aria-label="Download imediato apos confirmacao de pagamento"
      className="absolute top-3 right-12 z-10 px-1.5 py-0.5 rounded bg-cyan-500/90 text-white text-[9px] font-bold uppercase tracking-wide flex items-center gap-0.5 shadow-md backdrop-blur"
    >
      <Zap className="w-2.5 h-2.5 fill-white" aria-hidden="true" />
      Instant
    </div>
  );
}
