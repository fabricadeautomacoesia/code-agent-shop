'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { Clock, ChevronRight } from 'lucide-react';
import { Api } from '@/lib/api';
import { useAuth } from '@/lib/store';

/**
 * MLB-NEW WORKER 16: Variante compact horizontal-scroll de RecentlyViewed
 * para uso em PDP. Mercado Livre exibe "Continuou navegando" abaixo dos
 * related products, com scroll horizontal de 6-8 thumbs pequenos.
 *
 * Diferenca vs RecentlyViewed (grid):
 *  - Horizontal scroll snap (flex overflow-x-auto)
 *  - Cards menores (w-32 thumb 80h) vs grid full cards
 *  - Filtra o produto atual via excludeId prop
 *  - Renderiza apenas se >= 3 produtos restantes (evita strip raquitica)
 *
 * Engagement esperado: usuario que veio direto via search e tem historico
 * em outros produtos -> oportunidade de cross-browse sem voltar para home.
 */
export function RecentlyViewedStrip({ excludeId }: { excludeId?: string }) {
  const { token } = useAuth();
  const [products, setProducts] = useState<any[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!token) { setLoaded(true); return; }
    Api.api<{ products: any[] }>('/products/recently-viewed?limit=12', { auth: token, cache: 'no-store' })
      .then((r) => {
        const filtered = (r.products || []).filter((p: any) => p.id !== excludeId);
        setProducts(filtered);
      })
      .catch(() => setProducts([]))
      .finally(() => setLoaded(true));
  }, [token, excludeId]);

  // Skip render se: nao carregou, nao logado, ou < 3 (evita strip raquitica)
  if (!loaded || !token || products.length < 3) return null;

  return (
    <section className="mt-12">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Clock className="w-5 h-5 text-magenta" />
          <h2 className="font-display font-bold text-xl">Continue navegando</h2>
        </div>
        <Link href="/conta" className="text-xs text-white/50 hover:text-magenta transition-colors flex items-center gap-1">
          Ver todos <ChevronRight className="w-3 h-3" />
        </Link>
      </div>

      {/* Horizontal scroll com snap suave + scrollbar custom hidden em mobile */}
      <div className="flex gap-3 overflow-x-auto pb-3 -mx-2 px-2 snap-x snap-mandatory scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
        {products.slice(0, 12).map((p: any) => (
          <Link key={p.id} href={`/product/${p.slug}`}
            className="glass flex-shrink-0 w-36 sm:w-40 snap-start group">
            <div className="w-full h-20 sm:h-24 relative overflow-hidden bg-gradient-vibe/10 rounded-t-lg">
              {p.cover_image_url ? (
                <Image src={p.cover_image_url} alt={p.title || 'Produto'}
                  fill sizes="160px" className="object-cover" loading="lazy" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-xl font-display font-bold opacity-20">CAS</div>
              )}
            </div>
            <div className="p-2.5">
              <div className="text-xs font-semibold leading-tight line-clamp-2 group-hover:text-magenta transition-colors mb-1">
                {p.title}
              </div>
              <div className="font-display font-bold text-sm text-magenta-glow">
                {p.is_free ? 'Gratis' : Api.formatBRL(p.price_cents)}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
