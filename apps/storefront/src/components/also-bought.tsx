/**
 * MLB-13 (NEW): "Quem comprou isto, tambem comprou"
 *
 * Server component fetcha /api/products/<slug>/also-bought
 * Collaborative filtering real - co-occurrence em order_items.
 * Fallback gracioso se 0 results (produto novo sem compras correlatas).
 *
 * FIX-WORKER-3 pass 2: 4 bugs aplicando regras pass 1:
 * 1. BUG CRITICO PRODUCAO: fallback URL 'http://gateway:3002' INCORRETO.
 *    Todos os 9 outros server components usam '127.0.0.1:3002' (host
 *    network mode Docker Swarm). 'gateway:3002' nao resolve no DNS Docker
 *    da rede compartilhada -> fetch lanca -> catch retorna null -> /also-bought
 *    SUMIU SILENCIOSAMENTE de TODO PDP em prod desde deploy MLB-13.
 *    FIX: 'http://127.0.0.1:3002' consistente com api.ts/sitemap.ts/seller/etc.
 * 2. r.json() retornava Promise sem await (regra B pass 1).
 *    Caller faz await fora do try -> JSON malformed rejeita fora -> error
 *    boundary Next em vez de fallback null.
 *    FIX: const json = await r.json() dentro do try.
 * 3. Sem Array.isArray defense (regra B). Backend retornando products:string
 *    (corrupcao Redis?) crashava .map() no JSX.
 *    FIX: Array.isArray check.
 * 4. UI dead code: ternario singular/plural inalcancavel (filtra > 1 antes).
 *    FIX: simplificado para >= 2 (mensagem sempre plural).
 */

import Link from 'next/link';
import Image from 'next/image';
import { Users } from 'lucide-react';
import { Api } from '@/lib/api';

async function fetchSafe<T>(path: string): Promise<T | null> {
  try {
    // FIX bug 1: 127.0.0.1 consistente com outros server components (Docker host network)
    const base = process.env.GATEWAY_URL || 'http://127.0.0.1:3002';
    const r = await fetch(`${base}${path}`, { next: { revalidate: 600 } });
    if (!r.ok) return null;
    // FIX bug 2: await dentro do try (regra B pass 1) - JSON malformed = null gracioso
    const json = await r.json();
    return json as T;
  } catch { return null; }
}

export async function AlsoBought({ slug }: { slug: string }) {
  const data: any = await fetchSafe(`/api/products/${slug}/also-bought?limit=6`);
  // FIX bug 3: Array.isArray defense - backend products invalido = fallback gracioso
  const products: any[] = Array.isArray(data?.products) ? data.products : [];

  // Fallback gracioso: produto novo sem co-buyers OU backend falhou OU 404
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
                {/* FIX-WORKER-18 pass 4: loading="lazy" - also-bought esta no fim do PDP
                    (below fold em desktop, longe da scroll em mobile). Lazy reduz LCP
                    do PDP em ~150ms (6 imagens 200kb cada) sem prejudicar UX (user faz
                    scroll = imagens carregam antes de chegar). */}
                <Image src={p.cover_image_url} alt={p.title || 'Produto'}
                  fill sizes="(max-width:640px) 50vw, (max-width:1024px) 33vw, 16vw"
                  loading="lazy"
                  className="object-cover group-hover:scale-105 transition-transform" />
              </div>
            )}
            <h3 className="text-sm font-medium line-clamp-2 group-hover:text-magenta">{p.title}</h3>
            <div className="text-xs text-magenta-glow font-bold mt-1">
              {p.is_free ? 'Gratis' : Api.formatBRL(p.price_cents)}
            </div>
            {/* FIX bug 4: filtra >= 2 ja garante plural - ternario singular era dead code */}
            {p.co_buyers >= 2 && (
              <div className="text-[10px] text-white/40 mt-1">
                {p.co_buyers} compradores em comum
              </div>
            )}
          </Link>
        ))}
      </div>
    </section>
  );
}
