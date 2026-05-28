'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { Clock, ChevronRight, Star } from 'lucide-react';
import { Api } from '@/lib/api';
import { useAuth } from '@/lib/store';
import { Installments } from './installments';

/**
 * MLB-NEW: "Vistos recentemente" - secao client-side que aparece SE user logado
 * E tem produtos vistos nos ultimos 14 dias. Renderiza vazio (null) caso contrario.
 */
export function RecentlyViewed() {
  const { token } = useAuth();
  const [products, setProducts] = useState<any[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!token) { setLoaded(true); return; }
    Api.api<{ products: any[] }>('/products/recently-viewed?limit=8', { auth: token, cache: 'no-store' })
      .then((r) => setProducts(r.products || []))
      .catch(() => setProducts([]))
      .finally(() => setLoaded(true));
  }, [token]);

  if (!loaded || !token || products.length === 0) return null;

  return (
    <section className="container mx-auto px-6 my-16">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Clock className="w-6 h-6 text-magenta" />
          <h2 className="font-display font-bold text-2xl">Vistos recentemente</h2>
        </div>
        <Link href="/conta" className="text-sm text-white/60 hover:text-magenta transition-colors flex items-center gap-1">
          Ver todos <ChevronRight className="w-4 h-4" />
        </Link>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
        {products.map((p: any) => (
          <Link key={p.id} href={`/product/${p.slug}`}
            className="glass overflow-hidden card-hover group">
            <div className="aspect-video relative overflow-hidden bg-gradient-vibe/10">
              {p.cover_image_url ? (
                <Image src={p.cover_image_url} alt={p.title}
                  fill sizes="(max-width:640px) 50vw, (max-width:1024px) 33vw, 25vw"
                  className="object-cover card-image-zoom"
                  loading="lazy" />
              ) : (
                <div className="w-full h-full flex items-center justify-center bg-gradient-vibe/10">
                  <div className="text-3xl font-display font-bold opacity-20">CAS</div>
                </div>
              )}
              {p.flash_promo_active && (
                <div className="absolute top-2 left-2 px-2 py-0.5 rounded bg-orange-500 text-white text-[10px] font-bold">
                  -{p.flash_promo_discount_pct}%
                </div>
              )}
            </div>
            <div className="p-3">
              <div className="text-[10px] text-white/40 uppercase tracking-wider mb-1">{p.kind?.replace(/_/g, ' ')}</div>
              <h3 className="font-display font-semibold text-sm leading-tight line-clamp-2 group-hover:text-magenta transition-colors mb-2">
                {p.title}
              </h3>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1 text-xs">
                  <Star className="w-3 h-3 fill-yellow-400 text-yellow-400" aria-hidden="true" />
                  <span className="font-semibold">{p.avg_rating ? Number(p.avg_rating).toFixed(1) : '-'}</span>
                </div>
                <div className="font-display font-bold text-sm text-magenta-glow">
                  {p.is_free ? 'Gratis' : Api.formatBRL(p.price_cents)}
                </div>
              </div>
              {/* MLB-NEW WORKER 17: parcelas compact */}
              <Installments priceCents={p.price_cents} isFree={p.is_free} variant="card" />
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
