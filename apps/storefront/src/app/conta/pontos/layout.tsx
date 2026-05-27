import type { Metadata } from 'next';

// FIX-WORKER-9 pass 7: /conta/pontos enriquecido (canonical + og)
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
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
