import type { Metadata } from 'next';

// FIX-WORKER-9: metadata para /conta/pedidos/[id] (era 'Code & Agent Shop' generico)
type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return {
    title: `Pedido ${id.slice(0, 8)} - Code & Agent Shop`,
    description: 'Detalhes do pedido, status de pagamento, download e licencas geradas.',
    robots: { index: false, follow: false },
  };
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
