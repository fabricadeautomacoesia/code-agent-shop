import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Trophy, TrendingUp } from 'lucide-react';
import type { Metadata } from 'next';
import { Api } from '@/lib/api';
import { ProductCard } from '@/components/product-card';

export const revalidate = 60;

// FIX-WORKER-10: agora distingue 404 (slug invalido) de 200+empty (categoria sem produtos)
async function fetchTopSellers(slug: string): Promise<{ status: number; data: any | null }> {
  try {
    const base = process.env.GATEWAY_URL || 'http://127.0.0.1:3002';
    const r = await fetch(`${base}/api/search/top-sellers/${slug}?limit=12`, { cache: 'no-store' });
    const data = await r.json().catch(() => null);
    return { status: r.status, data };
  } catch { return { status: 0, data: null }; }
}

// FIX-WORKER-9 pass 121: generateMetadata dinamico p/ SEO categoria
// Antes: pages /categoria/automacao /categoria/seo etc herdavam metadata root
// generica. Search engines indexavam todas com mesmo title -> duplicate content.
// Agora: title + description per-slug + canonical + openGraph dinamico.
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const displayName = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  // Tentativa de fetch p/ description rica - fallback p/ generic se 404
  const { data } = await fetchTopSellers(slug);
  const desc = data?.category?.description
    || `Mais vendidos em ${displayName}: automacoes, agentes IA, n8n workflows e templates verificados pela Code & Agent Shop.`;
  return {
    title: `${displayName} - Mais Vendidos | Code & Agent Shop`,
    description: desc.slice(0, 160),
    alternates: { canonical: `/categoria/${slug}` },
    openGraph: {
      type: 'website',
      url: `https://cas.inovareinteligenciaartificial.com/categoria/${slug}`,
      title: `${displayName} - Mais Vendidos`,
      description: desc.slice(0, 160),
      images: ['/opengraph-image'],
    },
    twitter: {
      card: 'summary_large_image',
      title: `${displayName} - Mais Vendidos`,
      description: desc.slice(0, 160),
    },
    keywords: [displayName, 'mais vendidos', 'marketplace', 'automacoes', 'agentes IA'],
  };
}

export default async function CategoriaPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { status, data } = await fetchTopSellers(slug);
  // FIX-WORKER-10: 404 -> notFound() (antes mostrava "Nenhum produto encontrado" igual a categoria vazia)
  if (status === 404) notFound();
  const products = data?.products || [];
  const category = data?.category;
  const displayName = category?.name || slug.replace(/-/g, ' ');

  return (
    <div className="container mx-auto px-6 py-8">
      <Link href="/products" className="text-sm text-white/60 hover:text-white">&larr; Catalogo</Link>

      <div className="mt-4 mb-8">
        <h1 className="font-display font-bold text-4xl mb-2 capitalize flex items-center gap-3">
          <Trophy className="w-8 h-8 text-yellow-400" />
          Mais vendidos: {displayName}
        </h1>
        {category?.description && <p className="text-sm text-white/60 mb-2">{category.description}</p>}
        <p className="text-white/60 flex items-center gap-2">
          <TrendingUp className="w-4 h-4" /> Top {products.length} produtos com mais vendas na categoria
        </p>
      </div>

      {products.length === 0 ? (
        <div className="glass p-12 text-center text-white/60">
          Nenhum produto encontrado nesta categoria.
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {products.map((p: any, i: number) => (
            <div key={p.id} className="relative">
              {i === 0 && (
                <div className="absolute -top-2 -right-2 z-10 px-3 py-1 rounded-full bg-gradient-to-r from-yellow-400 to-orange-500 text-black text-xs font-bold shadow-lg shadow-yellow-500/50 flex items-center gap-1">
                  <Trophy className="w-3 h-3" /> 1o LUGAR
                </div>
              )}
              {i > 0 && i < 3 && (
                <div className="absolute -top-2 -right-2 z-10 px-3 py-1 rounded-full bg-white/90 text-black text-xs font-bold shadow-lg">
                  {i + 1}o lugar
                </div>
              )}
              <ProductCard product={p} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
