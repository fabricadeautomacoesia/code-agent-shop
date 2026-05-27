import type { Metadata } from 'next';

// FIX-WORKER-9: metadata para /conta/pedidos (era 'Code & Agent Shop' generico)
export const metadata: Metadata = {
  title: 'Meus pedidos - Code & Agent Shop',
  description: 'Historico completo de pedidos, status de pagamento e downloads das automacoes adquiridas.',
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
