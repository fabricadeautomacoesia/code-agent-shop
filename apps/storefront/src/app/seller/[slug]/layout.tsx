import type { Metadata } from 'next';

type Props = { params: Promise<{ slug: string }> };

/**
 * FIX-WORKER-9 pass 232: dynamic metadata p/ /seller/[slug]
 *
 * PRE-FIX: nenhum layout.tsx -> heranca de root metadata generico
 * ("Code & Agent Shop"). Compartilhar /seller/joao no WhatsApp/Twitter
 * mostrava preview generico (titulo + descricao da home) em vez do nome
 * da loja. SEO: Google indexava perfis com title duplicado vs home.
 *
 * POST-FIX: generateMetadata busca seller via /api/sellers/:slug, usa
 * store_name + store_description. Fallback gracioso ao slug se 404.
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  let name = slug.replace(/-/g, ' ');
  let description = `Loja ${name} no Code & Agent Shop - automacoes e agentes IA validados.`;
  let bannerUrl: string | undefined;
  try {
    const base = process.env.GATEWAY_URL || 'http://127.0.0.1:3002';
    const r = await fetch(`${base}/api/sellers/${slug}`, { cache: 'no-store' });
    if (r.ok) {
      const d = await r.json();
      if (d?.seller?.store_name) name = d.seller.store_name;
      if (d?.seller?.store_description) {
        description = d.seller.store_description.slice(0, 160);
      }
      if (d?.seller?.store_banner_url) bannerUrl = d.seller.store_banner_url;
    }
  } catch {}
  return {
    title: `${name} - Code & Agent Shop`,
    description,
    alternates: { canonical: `/seller/${slug}` },
    openGraph: {
      type: 'profile',
      title: `${name} - Vendedor verificado`,
      description,
      url: `/seller/${slug}`,
      ...(bannerUrl ? { images: [{ url: bannerUrl, alt: `Banner ${name}` }] } : {}),
    },
    twitter: {
      card: bannerUrl ? 'summary_large_image' : 'summary',
      title: name,
      description,
      ...(bannerUrl ? { images: [bannerUrl] } : {}),
    },
  };
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
