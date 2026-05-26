import Link from 'next/link';
import { Star, ShoppingCart, Award } from 'lucide-react';
import { Api } from '@/lib/api';

const TIER_BADGE: Record<string, { label: string; color: string }> = {
  iniciante:      { label: 'Iniciante', color: 'bg-gray-500/20 text-gray-300' },
  bronze:         { label: 'Bronze', color: 'bg-amber-700/20 text-amber-400' },
  prata:          { label: 'Prata', color: 'bg-slate-400/20 text-slate-300' },
  ouro:           { label: 'Ouro', color: 'bg-yellow-500/20 text-yellow-300' },
  platinum:       { label: 'Platinum', color: 'bg-cyan-400/20 text-cyan-300' },
  lider_platinum: { label: 'Lider Platinum', color: 'bg-magenta/20 text-magenta-glow' },
};

export function ProductCard({ product }: { product: any }) {
  const tier = TIER_BADGE[product.reputation_tier] || TIER_BADGE.iniciante;
  return (
    <Link href={`/product/${product.slug}`}>
      <article className="glass group overflow-hidden hover:scale-[1.02] hover:border-white/15 transition-all duration-300 reveal-up cursor-pointer h-full flex flex-col">
        <div className="aspect-video relative overflow-hidden bg-gradient-vibe/10">
          {product.cover_image_url ? (
            <img
              src={product.cover_image_url} alt={product.title}
              className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-700"
              loading="lazy"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-gradient-vibe/10">
              <div className="text-6xl font-display font-bold opacity-20">CAS</div>
            </div>
          )}
          {product.is_platform_owned && (
            <div className="absolute top-3 right-3 px-2 py-1 rounded-md bg-magenta/90 text-white text-xs font-semibold flex items-center gap-1">
              <Award className="w-3 h-3" /> Oficial
            </div>
          )}
          {product.is_top_seller && (
            <div className="absolute top-3 left-3 px-2 py-1 rounded-md bg-gradient-to-r from-yellow-400 to-orange-500 text-black text-[10px] font-bold flex items-center gap-1 shadow-lg">
              MAIS VENDIDO
            </div>
          )}
        </div>
        <div className="p-5 flex flex-col flex-1">
          <div className="flex items-start justify-between gap-2 mb-2">
            <span className="text-xs text-white/40 uppercase tracking-wider">{product.kind?.replace(/_/g, ' ')}</span>
            {product.reputation_tier && (
              <span className={`text-[10px] px-2 py-0.5 rounded-full ${tier.color}`}>{tier.label}</span>
            )}
          </div>
          <h3 className="font-display font-semibold text-lg leading-tight mb-2 line-clamp-2 group-hover:text-magenta transition-colors">
            {product.title}
          </h3>
          {product.subtitle && <p className="text-sm text-white/60 line-clamp-2 mb-3">{product.subtitle}</p>}
          {product.tech_stack && product.tech_stack.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-3">
              {product.tech_stack.slice(0, 3).map((t: string) => (
                <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-white/60 font-mono">{t}</span>
              ))}
            </div>
          )}
          <div className="mt-auto flex items-center justify-between pt-3 border-t border-white/5">
            <div className="flex items-center gap-1.5 text-sm">
              <Star className="w-4 h-4 fill-yellow-400 text-yellow-400" />
              <span className="font-semibold">{product.avg_rating ? Number(product.avg_rating).toFixed(1) : '-'}</span>
              <span className="text-xs text-white/40">({product.review_count || 0})</span>
            </div>
            <div className="text-right">
              <div className="text-xs text-white/40">{product.sales_count || 0} vendas</div>
              <div className="font-display font-bold text-magenta-glow text-lg">
                {product.is_free ? 'Gratis' : Api.formatBRL(product.price_cents)}
              </div>
            </div>
          </div>
        </div>
      </article>
    </Link>
  );
}
