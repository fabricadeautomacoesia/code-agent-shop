import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Star, Award, Package, TrendingUp, MapPin, Calendar } from 'lucide-react';
import { api } from '@/lib/api';
import { ProductCard } from '@/components/product-card';

export const revalidate = 60;

const TIER_BADGE: Record<string, { label: string; color: string }> = {
  iniciante:      { label: 'Iniciante',      color: 'bg-gray-500/20 text-gray-300' },
  bronze:         { label: 'Bronze',         color: 'bg-amber-700/20 text-amber-400' },
  prata:          { label: 'Prata',          color: 'bg-slate-400/20 text-slate-300' },
  ouro:           { label: 'Ouro',           color: 'bg-yellow-500/20 text-yellow-300' },
  platinum:       { label: 'Platinum',       color: 'bg-cyan-400/20 text-cyan-300' },
  lider_platinum: { label: 'Lider Platinum', color: 'bg-magenta/20 text-magenta-glow' },
};

async function fetchSafe<T>(path: string): Promise<T | null> {
  try {
    const base = process.env.GATEWAY_URL || 'http://127.0.0.1:3002';
    const r = await fetch(`${base}${path}`, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// SEO dinamico para pagina de vendedor
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const data: any = await fetchSafe(`/api/sellers/${slug}`);
  const seller = data?.seller;
  if (!seller) return { title: 'Vendedor - Code & Agent Shop' };
  const title = `${seller.store_name || seller.display_name || slug} - Vendedor | Code & Agent Shop`;
  const tierLabel = seller.reputation_tier ? `Tier ${seller.reputation_tier}` : '';
  const stats = `${seller.total_sales || 0} vendas - ${seller.products_count || 0} produtos`;
  const description = (seller.bio || `Loja oficial ${seller.store_name || slug}. ${stats}. ${tierLabel}.`)
    .replace(/<[^>]+>/g, '')
    .slice(0, 160);
  const image = seller.logo_url || seller.banner_url || undefined;
  const url = `https://cas.inovareinteligenciaartificial.com/seller/${slug}`;
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title, description, url, type: 'profile',
      siteName: 'Code & Agent Shop',
      images: image ? [{ url: image, alt: seller.store_name || slug }] : undefined,
    },
    twitter: {
      card: image ? 'summary_large_image' : 'summary',
      title, description,
      images: image ? [image] : undefined,
    },
    robots: { index: true, follow: true },
  };
}

export default async function SellerPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const data: any = await fetchSafe(`/api/sellers/${slug}`);
  if (!data?.seller) notFound();
  const seller = data.seller;
  const prods: any = await fetchSafe(`/api/sellers/${slug}/products?limit=24`);
  const products = prods?.products || [];

  const tier = TIER_BADGE[seller.reputation_tier] || TIER_BADGE.iniciante;

  return (
    <div className="container mx-auto px-6 py-8">
      <Link href="/products" className="text-sm text-white/60 hover:text-white">&larr; Catalogo</Link>

      {/* Header com banner */}
      <div className="glass overflow-hidden mt-4 mb-8 relative">
        {seller.store_banner_url && (
          <div className="h-48 bg-cover bg-center opacity-50"
            style={{ backgroundImage: `url(${seller.store_banner_url})` }} />
        )}
        <div className="p-8 flex flex-col md:flex-row gap-6 items-start md:items-center">
          {seller.store_logo_url ? (
            <img src={seller.store_logo_url} alt={seller.store_name}
              className="w-24 h-24 rounded-xl object-cover border-2 border-magenta" />
          ) : (
            <div className="w-24 h-24 rounded-xl bg-gradient-vibe flex items-center justify-center text-3xl font-display font-bold">
              {seller.store_name?.[0] || 'S'}
            </div>
          )}
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-2 flex-wrap">
              <h1 className="font-display font-bold text-3xl">{seller.store_name}</h1>
              <span className={`text-xs px-2 py-1 rounded ${tier.color} flex items-center gap-1`}>
                <Award className="w-3 h-3" /> {tier.label}
              </span>
            </div>
            {seller.store_description && <p className="text-white/70 mb-4 max-w-2xl">{seller.store_description}</p>}
            <div className="flex flex-wrap gap-6 text-sm text-white/60">
              <span className="flex items-center gap-2"><Package className="w-4 h-4" /> {seller.total_products_active || 0} produtos</span>
              <span className="flex items-center gap-2"><TrendingUp className="w-4 h-4" /> {seller.total_sales || 0} vendas</span>
              {seller.avg_rating && <span className="flex items-center gap-2"><Star className="w-4 h-4 fill-yellow-400 text-yellow-400" /> {Number(seller.avg_rating).toFixed(1)}</span>}
              <span className="flex items-center gap-2"><Calendar className="w-4 h-4" /> desde {new Date(seller.created_at).toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' })}</span>
              <span className="font-mono text-xs">score {seller.reputation_score}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Produtos do seller */}
      <h2 className="font-display font-bold text-2xl mb-6">Produtos desta loja</h2>
      {products.length === 0 ? (
        <div className="glass p-12 text-center text-white/60">
          <Package className="w-16 h-16 mx-auto mb-4 text-white/30" />
          Este vendedor ainda nao tem produtos aprovados na vitrine.
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {products.map((p: any) => <ProductCard key={p.id} product={p} />)}
        </div>
      )}
    </div>
  );
}
