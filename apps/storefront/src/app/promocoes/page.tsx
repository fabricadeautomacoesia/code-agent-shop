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
  // FIX-WORKER-9 pass 3: canonical (estava herdando root '/' incorretamente)
  alternates: { canonical: '/promocoes' },
  // FIX-WORKER-9 pass 133: openGraph + twitter + keywords (faltavam - compartilhamento
  // social de URLs /promocoes em WhatsApp/Twitter/Slack mostrava preview generico
  // herdado do root layout /, sem destaque para a feature "promocoes relampago").
  openGraph: {
    type: 'website',
    url: 'https://cas.inovareinteligenciaartificial.com/promocoes',
    title: 'Promocoes Relampago - Code & Agent Shop',
    description: 'Descontos por tempo limitado em automacoes e agentes IA. Aproveite enquanto duram!',
    images: ['/opengraph-image'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Promocoes Relampago - Code & Agent Shop',
    description: 'Descontos por tempo limitado em automacoes e agentes IA.',
    images: ['/opengraph-image'],
  },
  keywords: ['promocoes', 'descontos', 'relampago', 'flash sale', 'automacoes', 'agentes IA', 'marketplace'],
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

      {/* FIX-WORKER-8 pass 4: header responsive (era text-5xl + Zap w-16 fixed = mobile overflow)
          - text-3xl em mobile -> sm:text-5xl em >=640px
          - Zap w-12 mobile -> sm:w-16 desktop
          - mb-4 -> mb-3 sm:mb-4 (espacamento proporcional) */}
      <div className="mt-4 mb-8 text-center">
        <Zap className="w-12 h-12 sm:w-16 sm:h-16 mx-auto text-orange-400 mb-3 sm:mb-4 animate-pulse" aria-hidden="true" />
        <h1 className="font-display font-bold text-3xl sm:text-5xl mb-3 bg-gradient-to-r from-orange-400 to-magenta bg-clip-text text-transparent">
          Promocoes Relampago
        </h1>
        <p className="text-sm sm:text-base text-white/60">Descontos por tempo limitado - corre antes que acabe!</p>
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
              {/* FIX-WORKER-8: next/image substituindo <img> raw (perf + a11y) */}
              <Link href={`/product/${p.slug}`} className="block">
                {p.cover_image_url && (
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
                {/* FIX-WORKER-8 pass 4: row preco+CTA com flex-wrap mobile-safe.
                    ANTES: flex items-center gap-4 (3 elementos lado a lado)
                       Em 375px: preco antigo (~70px) + preco novo text-3xl (~120px) +
                       CTA "Comprar agora" (~150px) = 340px > viewport util ~343px
                       Visual: overflow horizontal OU squeeze ilegivel
                    AGORA: flex-wrap + sm:flex-nowrap (mobile flex-wrap, desktop linha)
                    Tambem: text-2xl mobile -> sm:text-3xl desktop */}
                <div className="flex flex-wrap sm:flex-nowrap items-center gap-3 sm:gap-4">
                  <span className="text-white/50 line-through text-base sm:text-lg">{Api.formatBRL(p.price_cents)}</span>
                  <span className="font-display font-bold text-2xl sm:text-3xl text-magenta-glow">
                    {Api.formatBRL(p.discounted_price_cents)}
                  </span>
                  <Link href={`/product/${p.slug}`}
                    aria-label={`Comprar ${p.title} com ${p.flash_promo_discount_pct}% off`}
                    className="btn-primary text-sm sm:ml-auto w-full sm:w-auto text-center">
                    Comprar agora
                  </Link>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
