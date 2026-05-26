import Link from 'next/link';
import { Trophy, TrendingUp } from 'lucide-react';
import { Api } from '@/lib/api';
import { ProductCard } from '@/components/product-card';

export const revalidate = 60;

async function fetchSafe<T>(path: string): Promise<T | null> {
  try {
    const base = process.env.GATEWAY_URL || 'http://127.0.0.1:3002';
    const r = await fetch(`${base}${path}`, { cache: 'no-store' });
    if (!r.ok) return null;
    return r.json();
  } catch { return null; }
}

export default async function CategoriaPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const top: any = await fetchSafe(`/api/search/top-sellers/${slug}?limit=12`);
  const products = top?.products || [];

  return (
    <div className="container mx-auto px-6 py-8">
      <Link href="/products" className="text-sm text-white/60 hover:text-white">&larr; Catalogo</Link>

      <div className="mt-4 mb-8">
        <h1 className="font-display font-bold text-4xl mb-2 capitalize flex items-center gap-3">
          <Trophy className="w-8 h-8 text-yellow-400" />
          Mais vendidos: {slug.replace(/-/g, ' ')}
        </h1>
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
