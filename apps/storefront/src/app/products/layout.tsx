import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Catalogo Completo - Code & Agent Shop',
  description: 'Encontre automacoes, workflows n8n, agentes IA, scripts e templates curados. Filtros por categoria, preco e tier do vendedor.',
  openGraph: {
    type: 'website',
    locale: 'pt_BR',
    title: 'Catalogo - Code & Agent Shop',
    description: 'O maior marketplace de automacoes e agentes IA do Brasil.',
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
