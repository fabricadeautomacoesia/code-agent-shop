import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Catalogo Completo - Code & Agent Shop',
  description: 'Encontre automacoes, workflows n8n, agentes IA, scripts e templates curados. Filtros por categoria, preco e tier do vendedor.',
  // FIX-WORKER-9 pass 3: canonical SEM query strings (?sort=X ?page=N ?category=Y eram URLs separadas)
  alternates: { canonical: '/products' },
  openGraph: {
    type: 'website',
    locale: 'pt_BR',
    url: 'https://cas.inovareinteligenciaartificial.com/products',
    title: 'Catalogo Completo - Code & Agent Shop',
    description: 'O maior marketplace de automacoes e agentes IA do Brasil. Filtros por categoria, kind, preco e tier.',
    images: ['/opengraph-image'],
  },
  // FIX-WORKER-9 pass 118: + keywords + twitter card
  keywords: ['catalogo', 'automacoes', 'agentes IA', 'n8n', 'workflows', 'scripts', 'templates', 'prompts'],
  twitter: {
    card: 'summary_large_image',
    title: 'Catalogo Completo | Code & Agent Shop',
    description: 'O maior marketplace de automacoes e agentes IA do Brasil.',
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
