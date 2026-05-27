/**
 * MLB-13 (NEW): "Quem comprou isto, tambem comprou"
 *
 * Server component fetcha /api/products/<slug>/also-bought
 * Collaborative filtering real - co-occurrence em order_items.
 * Fallback gracioso se 0 results (produto novo sem compras correlatas).
 */

import Link from 'next/link';
import Image from 'next/image';
import { Users } from 'lucide-react';
import { Api } from '@/lib/api';

async function fetchSafe<T>(path: string): Promise<T | null> {
  try {
    const base = process.env.GATEWAY_URL || 'http://gateway:3002';
    const r = await fetch(`${base}${path}`, { next: { revalidate: 600 } });
    if (!r.ok) return null;
    return r.json();
  } catch { return null; }
}

export async function AlsoBought({ slug }: { slug: string }) {
  const data: any = await fetchSafe(`/api/products/${slug}/also-bought?limit=6`);
  const products = data?.products || [];

  // Fallback gracioso: produto novo sem co-buyers
  if (products.length === 0) return null;

  return (
    <section className="mt-12 reveal-up">
      <div className="flex items-center gap-2 mb-6">
        <Users className="w-5 h-5 text-magenta" />
        <h2 className="font-display font-bold text-2xl">Quem comprou isto, tambem comprou</h2>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        {products.map((p: any) => (
          <Link key={p.id} href={`/product/${p.slug}`}
            className="glass p-3 hover:scale-[1.03] transition-transform group">
            {p.cover_image_url && (
              <div className="aspect-square relative rounded-lg overflow-hidden mb-2 bg-white/5">
                <Image src={p.cover_image_url} alt={p.title || 'Produto'}
                  fill sizes="(max-width:640px) 50vw, (max-width:1024px) 33vw, 16vw"
                  className="object-cover group-hover:scale-105 transition-transform" />
              </div>
            )}
            <h3 className="text-sm font-medium line-clamp-2 group-hover:text-magenta">{p.title}</h3>
            <div className="text-xs text-magenta-glow font-bold mt-1">
              {p.is_free ? 'Gratis' : Api.formatBRL(p.price_cents)}
            </div>
            {p.co_buyers > 1 && (
              <div className="text-[10px] text-white/40 mt-1">
                {p.co_buyers} {p.co_buyers === 1 ? 'comprador em comum' : 'compradores em comum'}
              </div>
            )}
          </Link>
        ))}
      </div>
    </section>
  );
}
