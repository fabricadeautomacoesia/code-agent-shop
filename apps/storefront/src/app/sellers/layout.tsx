import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Vendedores - Code & Agent Shop',
  description: 'Conheca os criadores de automacoes, agentes IA e workflows n8n do marketplace. Filtre por tier de reputacao.',
  // FIX-WORKER-9 pass 3: canonical sem query strings
  alternates: { canonical: '/sellers' },
  openGraph: {
    type: 'website',
    locale: 'pt_BR',
    title: 'Vendedores - Code & Agent Shop',
    description: 'Criadores verificados de automacoes e agentes IA.',
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
