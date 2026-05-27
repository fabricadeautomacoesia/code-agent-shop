'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Sparkles, ChevronRight } from 'lucide-react';
import { Api } from '@/lib/api';
import { useAuth } from '@/lib/store';
import { ProductCard } from './product-card';

/**
 * MLB-NEW WORKER 16: "Recomendados para voce" - secao client-side que aparece
 * SE user logado E backend tem ao menos 4 sugestoes baseadas em historico de
 * visualizacao (product_views) + categorias mais vistas nos ultimos 30 dias.
 *
 * Mercado Livre usa este padrao para personalizar a home apos primeira visita -
 * principal driver de conversao apos onboarding.
 *
 * Backend: GET /api/products/recommendations/for-me (ja existente).
 * Algoritmo: WITH user_categories AS (...) + WHERE NOT IN cart_or_owned.
 */
export function ForYou() {
  const { token, user } = useAuth();
  const [products, setProducts] = useState<any[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!token) { setLoaded(true); return; }
    Api.api<{ products: any[] }>('/products/recommendations/for-me', { auth: token, cache: 'no-store' })
      .then((r) => setProducts(r.products || []))
      .catch(() => setProducts([]))
      .finally(() => setLoaded(true));
  }, [token]);

  // Renderiza vazio se: nao logado OU < 4 recomendacoes (evita secao raquitica)
  if (!loaded || !token || products.length < 4) return null;

  const firstName = (user?.name || '').split(' ')[0] || 'voce';

  return (
    <section className="container mx-auto px-6">
      <div className="flex items-end justify-between mb-6">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-magenta/15 text-magenta-glow text-xs font-semibold mb-2">
            <Sparkles className="w-3.5 h-3.5" /> Personalizado
          </div>
          <h2 className="font-display font-bold text-3xl reveal-up">
            Recomendados para <span className="text-magenta-glow">{firstName}</span>
          </h2>
          <p className="text-sm text-white/50 mt-1">
            Baseado nos produtos que voce visualizou recentemente
          </p>
        </div>
        <Link href="/products" className="text-sm text-magenta hover:underline flex items-center gap-1">
          Ver mais <ChevronRight className="w-4 h-4" />
        </Link>
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
        {products.slice(0, 8).map((p) => <ProductCard key={p.id} product={p} />)}
      </div>
    </section>
  );
}
