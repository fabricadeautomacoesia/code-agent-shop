import Link from 'next/link';
import Image from 'next/image';
import { Zap } from 'lucide-react';
import { Api } from '@/lib/api';
import { ProductCard } from '@/components/product-card';
import { FlashPromoTimer } from '@/components/flash-promo-timer';

export const revalidate = 30;

export const metadata = {
  title: 'Promocoes Relampago - Code & Agent Shop',
  description: 'Descontos por tempo limitado em automacoes e agentes IA. Aproveite enquanto duram!',
};

async function fetchSafe<T>(path: string): Promise<T | null> {
  try {
    const base = process.env.GATEWAY_URL || 'http://127.0.0.1:3002';
    const r = await fetch(`${base}${path}`, { cache: 'no-store' });
    if (!r.ok) return null;
    return r.json();
  } catch { return null; }
}

export default async function PromocoesPage() {
  const data: any = await fetchSafe('/api/products/flash-promo/active');
  const products = data?.products || [];

  return (
    <div className="container mx-auto px-6 py-8">
      <Link href="/" className="text-sm text-white/60 hover:text-white">&larr; Voltar</Link>

      <div className="mt-4 mb-8 text-center">
        <Zap className="w-16 h-16 mx-auto text-orange-400 mb-4 animate-pulse" />
        <h1 className="font-display font-bold text-5xl mb-3 bg-gradient-to-r from-orange-400 to-magenta bg-clip-text text-transparent">
          Promocoes Relampago
        </h1>
        <p className="text-white/60">Descontos por tempo limitado - corre antes que acabe!</p>
      </div>

      {products.length === 0 ? (
        <div className="glass p-12 text-center">
          <Zap className="w-16 h-16 mx-auto text-white/20 mb-4" />
          <p className="text-xl mb-2">Nenhuma promocao ativa no momento</p>
          <p className="text-sm text-white/60 mb-4">Volte em breve - novas ofertas todos os dias!</p>
          <Link href="/products" className="btn-primary inline-block">Ver catalogo completo</Link>
        </div>
      ) : (
        <div className="space-y-6">
          {products.map((p: any) => (
            <div key={p.id} className="glass p-6 grid md:grid-cols-3 gap-6 items-center">
              <Link href={`/product/${p.slug}`} className="block">
                {p.cover_image_url && (
                  {/* FIX-WORKER-8: next/image substituindo <img> raw (perf + a11y) */}
                  <div className="w-full h-48 relative rounded-lg overflow-hidden">
                    <Image src={p.cover_image_url} alt={p.title || 'Produto'}
                      fill sizes="(max-width:768px) 100vw, 400px" className="object-cover" />
                  </div>
                )}
              </Link>
              <div className="md:col-span-2">
                <Link href={`/product/${p.slug}`}>
                  <h2 className="font-display font-bold text-2xl mb-2 hover:text-magenta transition-colors">{p.title}</h2>
                </Link>
                <p className="text-sm text-white/60 mb-3">{p.short_description}</p>
                <FlashPromoTimer endsAt={p.flash_promo_ends_at} discountPct={Number(p.flash_promo_discount_pct)} />
                <div className="flex items-center gap-4">
                  <span className="text-white/50 line-through text-lg">{Api.formatBRL(p.price_cents)}</span>
                  <span className="font-display font-bold text-3xl text-magenta-glow">
                    {Api.formatBRL(p.discounted_price_cents)}
                  </span>
                  <Link href={`/product/${p.slug}`} className="btn-primary text-sm ml-auto">Comprar agora</Link>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
