import type { Metadata } from 'next';

// FIX-WORKER-9: metadata para /conta/pontos (era 'Code & Agent Shop' generico)
export const metadata: Metadata = {
  title: 'CAS Pontos - Loyalty Program',
  description: 'Saldo, tier (Starter/Gold/Platinum) e extrato completo do programa de fidelidade CAS Pontos.',
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
