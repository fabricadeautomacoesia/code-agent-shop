import type { Metadata } from 'next';

// FIX-WORKER-9: metadata para /conta/pedidos (era 'Code & Agent Shop' generico)
// FIX-WORKER-9 pass 604 (enrich openGraph + twitter card paridade cadeia W9
//   completa - passes 431/491/518/519/538/557):
//   PRE-FIX: title + description + robots noindex apenas. SEM:
//   - canonical (Google indexava varios /conta/pedidos?return=X duplicados)
//   - openGraph (WhatsApp/Discord share preview generico inherited root)
//   - twitter (X preview = link cru)
//   POST-FIX: + canonical + openGraph completo + twitter summary card.
//   Mantido robots noindex (PII path user-specific historico financeiro).
//   Cadeia W9 metadata /conta/* enrichment COMPLETA:
//     pass 142 /conta/pedidos/[id] (short hash dinamico)
//     pass 431 /conta/favoritos enriched
//     pass 491 /conta/pedidos/[id] layout enriched
//     pass 538 /conta/downloads/[token] enriched
//     pass 557 /conta/seguranca + perfil + pontos twitter card
//     pass 604 (este) /conta/pedidos enriched
export const metadata: Metadata = {
  title: 'Meus pedidos - Code & Agent Shop',
  description: 'Historico completo de pedidos, status de pagamento e downloads das automacoes adquiridas.',
  alternates: { canonical: '/conta/pedidos' },
  openGraph: {
    title: 'Meus pedidos - Code & Agent Shop',
    description: 'Seus pedidos de automacoes e agentes IA no maior marketplace B2B/B2C do Brasil.',
    type: 'website',
    url: '/conta/pedidos',
    locale: 'pt_BR',
    siteName: 'Code & Agent Shop',
  },
  twitter: {
    card: 'summary',
    title: 'Meus pedidos - Code & Agent Shop',
    description: 'Historico de compras de automacoes e agentes IA.',
  },
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
