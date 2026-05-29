import type { Metadata } from 'next';

// FIX-WORKER-9 pass 7: /conta/pontos enriquecido (canonical + og)
// FIX-WORKER-9 pass 557 (twitter card paridade cadeia 431/491/518/519/538):
//   PRE-FIX (pass 7): openGraph completo MAS sem twitter card.
//   - User compartilha link em X/Twitter preview = link cru
//   POST-FIX: + twitter summary card paridade /conta/seguranca + /conta/perfil.
export const metadata: Metadata = {
  title: 'CAS Pontos - Loyalty Program',
  description: 'Saldo, tier (Starter/Gold/Platinum) e extrato completo do programa de fidelidade CAS Pontos.',
  alternates: { canonical: '/conta/pontos' },
  openGraph: {
    title: 'CAS Pontos - Code & Agent Shop',
    description: 'Ganhe pontos a cada compra. Tier Gold +20% bonus, Platinum +50%. 100pts = R$1 desconto.',
    type: 'website',
    url: '/conta/pontos',
    locale: 'pt_BR',
    siteName: 'Code & Agent Shop',
  },
  twitter: {
    card: 'summary',
    title: 'CAS Pontos - Loyalty Program',
    description: 'Ganhe pontos a cada compra. Tier Gold +20%, Platinum +50%.',
  },
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
