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
  // FIX-WORKER-9 pass 284: paridade seller [slug] metadata - twitter card + og.url
  //   PRE-FIX: openGraph sem url -> WhatsApp/Facebook share preview pode renderizar
  //   URL relativa /categoria/slug em vez de absoluta -> link quebrado em alguns clients.
  //   Twitter card faltando -> share no X/Twitter mostra summary generico do site
  //   sem destacar categoria especifica.
  //   POST-FIX: og.url + twitter.card minimo summary (sem imagem - top-sellers nao
  //   tem banner) para compartilhamento social rico.
  return {
    title: `Mais vendidos: ${name} - Code & Agent Shop`,
    description,
    alternates: { canonical: `/categoria/${slug}` },
    openGraph: {
      type: 'website',
      title: `Top ${name}`,
      description: `Mais vendidos em ${name}`,
      url: `/categoria/${slug}`,
    },
    twitter: {
      card: 'summary',
      title: `Top ${name} - Code & Agent Shop`,
      description,
    },
  };
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
