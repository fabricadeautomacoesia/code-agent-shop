import Link from 'next/link';
import Image from 'next/image';
import { Star, ShoppingCart, Award, TrendingUp } from 'lucide-react';
import { Api } from '@/lib/api';
import { Installments } from './installments';
import { CompareButton } from './compare-button';
import { OfficialBadge } from './official-badge';
import { WishlistButton } from './wishlist-button';
import { RecentSaleBadge } from './recent-sale-badge';
import { InstantDownloadBadge } from './instant-download-badge';
import { PixDiscountBadge } from './pix-discount-badge';
import { VerifiedSellerBadge } from './verified-seller-badge';

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
      <article className="glass group overflow-hidden card-hover hover:border-white/15 reveal-up cursor-pointer h-full flex flex-col">
        <div className="aspect-video relative overflow-hidden bg-gradient-vibe/10">
          {product.cover_image_url ? (
            <Image
              src={product.cover_image_url} alt={product.title}
              fill
              sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
              className="object-cover card-image-zoom"
              loading="lazy"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-gradient-vibe/10">
              <div className="text-6xl font-display font-bold opacity-20">CAS</div>
            </div>
          )}
          {/* MLB-NEW WORKER 16: combo selo Oficial+TopSeller (gold/magenta gradient quando ambos) */}
          <OfficialBadge isPlatformOwned={product.is_platform_owned} isTopSeller={product.is_top_seller} variant="card" />
          {/* MLB-NEW WORKER 16: Heart icon overlay para favoritar direto do card */}
          <WishlistButton productId={product.id} variant="card" />
          {/* MLB-NEW WORKER 16: badge "Vendido hoje/semana/mes" overlay bottom-left */}
          <RecentSaleBadge lastSaleAt={product.last_sale_at} variant="card" />
          {/* MLB-15 WORKER 16 pass 166: badge 'Download imediato' (pattern ML 'Chegada hoje' adapted) */}
          <InstantDownloadBadge hasPackage={!!product.package_url} variant="card" />
          {/* Mais vendido standalone (apenas se NAO combo) - posicao top-left */}
          {product.is_top_seller && !product.is_platform_owned && (
            <div className="absolute top-3 left-3 px-2 py-1 rounded-md bg-gradient-to-r from-yellow-400 to-orange-500 text-black text-[10px] font-bold flex items-center gap-1 shadow-lg">
              MAIS VENDIDO
            </div>
          )}
          {/* MLB-NEW WORKER 16: icone comparar overlay (bottom-right) */}
          <CompareButton variant="card" product={{
            id: product.id, slug: product.slug, title: product.title,
            cover_image_url: product.cover_image_url, price_cents: product.price_cents,
            is_free: product.is_free,
          }} />
        </div>
        <div className="p-5 flex flex-col flex-1">
          {/* FIX-WORKER-15 pass 234 (mobile 375px overflow): kind="n8n_workflow" ->
              "N8N WORKFLOW" (uppercase + tracking-wider) ocupa ~95px. Em mobile
              375px grid-cols-2 com gaps card width ~167px. Tier badge "Lider Platinum"
              ocupa 80px+. Sem truncate kind quebrava linha empurrando tier para
              proxima row, distorcia altura cards do grid (misalinhamento).
              POST-FIX: min-w-0 + truncate no kind + flex-shrink-0 no tier badge.
              Resultado: kind trunca "N8N WORKFL..." e tier badge sempre visivel. */}
          <div className="flex items-start justify-between gap-2 mb-2">
            <span className="text-xs text-white/40 uppercase tracking-wider min-w-0 truncate">{product.kind?.replace(/_/g, ' ')}</span>
            {product.reputation_tier && (
              <span className={`text-[10px] px-2 py-0.5 rounded-full flex-shrink-0 ${tier.color}`}>{tier.label}</span>
            )}
          </div>
          {/* MLB-17 WORKER 16 pass 169: Trust mark "Lider Premium"/"Verificado" para tiers altos */}
          {(product.reputation_tier === 'lider_platinum' || product.reputation_tier === 'platinum') && (
            <div className="mb-2">
              <VerifiedSellerBadge reputationTier={product.reputation_tier} variant="card" />
            </div>
          )}
          <h3 className="font-display font-semibold text-lg leading-tight mb-2 line-clamp-2 group-hover:text-magenta transition-colors">
            {product.title}
          </h3>
          {/* MLB-NEW WORKER 16: badge "+N vendidos" prominente (MLB psychology: arredonda p/ 10) */}
          {Number(product.sales_count) > 50 && (
            <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-green-500/15 text-green-300 text-[11px] font-semibold mb-2 border border-green-500/20">
              <TrendingUp className="w-3 h-3" />
              +{Math.floor(Number(product.sales_count) / 10) * 10} vendidos
            </div>
          )}
          {product.subtitle && <p className="text-sm text-white/60 line-clamp-2 mb-3">{product.subtitle}</p>}
          {product.tech_stack && product.tech_stack.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-3">
              {product.tech_stack.slice(0, 3).map((t: string) => (
                <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-white/60 font-mono">{t}</span>
              ))}
            </div>
          )}
          <div className="mt-auto flex items-center justify-between pt-3 border-t border-white/5">
            {/* FIX-WORKER-8 pass 255 (a11y Star decorativo):
                Star icon era anunciado como "imagem" antes do rating numerico.
                Pattern V8: icons decorativos sempre aria-hidden. Container span
                tem rating semantico - icon eh visual only. Aplicado 1 instance
                hot path (product-card cross-pages render). */}
            <div className="flex items-center gap-1.5 text-sm">
              <Star className="w-4 h-4 fill-yellow-400 text-yellow-400" aria-hidden="true" />
              <span className="font-semibold">{product.avg_rating ? Number(product.avg_rating).toFixed(1) : '-'}</span>
              <span className="text-xs text-white/40">({product.review_count || 0})</span>
            </div>
            <div className="text-right">
              {/* MLB-NEW WORKER 16: so mostra contagem aqui se < 50 (acima de 50 ja tem badge verde no topo) */}
              {Number(product.sales_count) > 0 && Number(product.sales_count) <= 50 && (
                <div className="text-xs text-white/40">{product.sales_count} vendas</div>
              )}
              <div className="font-display font-bold text-magenta-glow text-lg">
                {product.is_free ? 'Gratis' : Api.formatBRL(product.price_cents)}
              </div>
              {/* MLB-NEW WORKER 17: parcelamento sem juros (compact) */}
              <Installments priceCents={product.price_cents} isFree={product.is_free} variant="card" />
              {/* MLB-16 WORKER 16 pass 167: badge desconto PIX 5% */}
              <div className="mt-1.5">
                <PixDiscountBadge priceCents={product.price_cents} isFree={product.is_free} variant="card" />
              </div>
            </div>
          </div>
        </div>
      </article>
    </Link>
  );
}
