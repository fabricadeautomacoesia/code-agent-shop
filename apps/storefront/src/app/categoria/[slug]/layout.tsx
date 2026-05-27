import type { Metadata } from 'next';

type Props = { params: Promise<{ slug: string }> };

// FIX-WORKER-10: usa nome validado da categoria via /top-sellers/:slug (fallback p/ slug se 404)
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  let name = slug.replace(/-/g, ' ');
  let description = `Top produtos mais vendidos da categoria ${name}. Encontre os melhores ${name} validados por IA.`;
  try {
    const base = process.env.GATEWAY_URL || 'http://127.0.0.1:3002';
    const r = await fetch(`${base}/api/search/top-sellers/${slug}?limit=1`, { cache: 'no-store' });
    if (r.ok) {
      const d = await r.json();
      if (d?.category?.name) name = d.category.name;
      if (d?.category?.description) description = d.category.description;
    }
  } catch {}
  return {
    title: `Mais vendidos: ${name} - Code & Agent Shop`,
    description,
    openGraph: {
      type: 'website',
      title: `Top ${name}`,
      description: `Mais vendidos em ${name}`,
    },
  };
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
