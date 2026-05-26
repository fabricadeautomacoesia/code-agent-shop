import type { Metadata } from 'next';

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const cat = slug.replace(/-/g, ' ');
  return {
    title: `Mais vendidos: ${cat} - Code & Agent Shop`,
    description: `Top produtos mais vendidos da categoria ${cat}. Encontre os melhores ${cat} validados por IA.`,
    openGraph: {
      type: 'website',
      title: `Top ${cat}`,
      description: `Mais vendidos em ${cat}`,
    },
  };
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
