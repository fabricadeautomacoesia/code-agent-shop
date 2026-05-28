import { notFound } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { Star, Award, Download, Shield, Clock, Tag, RefreshCw, MessageCircle, CheckCircle2, Headphones, Heart } from 'lucide-react';
import { Api } from '@/lib/api';
import { AddToCart } from '@/components/add-to-cart';
import { WishlistButton } from '@/components/wishlist-button';
import { PriceAlertButton } from '@/components/price-alert-button';
import { AlsoBought } from '@/components/also-bought';
import { ProductTabs } from '@/components/product-tabs';
import { AskQuickButton } from '@/components/ask-quick-button';
import { CompareButton } from '@/components/compare-button';
import { ShareButton } from '@/components/share-button';
import { Installments } from '@/components/installments';
import { InstantDownloadBadge } from '@/components/instant-download-badge';
import { PixDiscountBadge } from '@/components/pix-discount-badge';
import { VerifiedSellerBadge } from '@/components/verified-seller-badge';
import { OfficialBadge } from '@/components/official-badge';
import { RecentlyViewedStrip } from '@/components/recently-viewed-strip';
import { RecentlyViewedGuest } from '@/components/recently-viewed-guest';
import { TrackProductViewClient } from '@/components/track-product-view-client';
import { RecentSaleBadge } from '@/components/recent-sale-badge';
import { JsonLd, productLd, breadcrumbLd } from '@/components/json-ld';

export const revalidate = 30;

// SEO dinamico - Open Graph + Twitter card por produto
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    const p: any = await Api.product(slug);
    const prod = p.product;
    if (!prod) return { title: 'Produto - Code & Agent Shop' };
    const priceLabel = prod.is_free ? 'Gratis' : `R$ ${(prod.price_cents/100).toFixed(2).replace('.', ',')}`;
    const title = `${prod.title} - ${priceLabel} | Code & Agent Shop`;
    const description = (prod.short_description || prod.description || '')
      .replace(/<[^>]+>/g, '')
      .slice(0, 160);
    const image = prod.cover_image_url || undefined;
    const url = `https://cas.inovareinteligenciaartificial.com/product/${slug}`;
    return {
      title,
      description,
      alternates: { canonical: url },
      openGraph: {
        title, description, url, type: 'website',
        siteName: 'Code & Agent Shop',
        images: image ? [{ url: image, alt: prod.title }] : undefined,
      },
      twitter: {
        card: image ? 'summary_large_image' : 'summary',
        title, description,
        images: image ? [image] : undefined,
      },
      robots: { index: true, follow: true },
    };
  } catch {
    return { title: 'Produto - Code & Agent Shop' };
  }
}

// FIX-WORKER-3 pass 1: 3 bugs criticos:
// 1. cache: 'no-store' invalida cache Redis backend TTL 300s (W18 pass2).
//    /also-bought irmao usa revalidate:600 corretamente - inconsistencia.
//    FIX: revalidate:300 alinhado com TTL backend (Next SSR dedupe + Redis hit).
// 2. r.json() falhava DENTRO de fetchRelated mas o throw subia ate o try
//    externo do ProductPage -> notFound() erroneo se backend OK + JSON malformado.
//    FIX: r.json() dentro do mesmo try.
// 3. fetchRelated dentro de Promise.all SEM .catch() proprio. Reviews/qna tem
//    .catch(()=>({...})) mas fetchRelated nao. Se backend lancar throw (timeout
//    no Next fetch wrapper), Promise.all rejeita -> try externo -> notFound().
//    PDP inteiro 404 por bug em recomendacoes? Catastrofico.
//    FIX: fetchRelated NUNCA throws (already, mas reforcado) + Promise.all
//    com .catch redundante por defesa em profundidade.
async function fetchRelated(slug: string): Promise<any[]> {
  try {
    const base = process.env.GATEWAY_URL || 'http://127.0.0.1:3002';
    const r = await fetch(`${base}/api/products/${slug}/related`, { next: { revalidate: 300 } });
    if (!r.ok) return [];
    const d = await r.json(); // FIX bug 2: dentro do try
    return Array.isArray(d?.products) ? d.products : [];
  } catch { return []; }
}

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  let product: any, reviews: any[] = [], qna: any[] = [], related: any[] = [];
  try {
    const p = await Api.product(slug);
    product = p.product;
    const [r, q, rel] = await Promise.all([
      Api.reviews(slug).catch(() => ({ reviews: [] })),
      Api.qna(slug).catch(() => ({ qna: [] })),
      // FIX bug 3: .catch defense-in-depth (fetchRelated ja eh safe mas defensivo)
      fetchRelated(slug).catch(() => []),
    ]);
    // FIX-WORKER-3 pass 241 (defensive null guard):
    //   Api.reviews().catch returns {reviews: []} mas backend respondendo
    //   200 com body {reviews: null} (malformed JSON ou bug serializer)
    //   passa o catch e atribui null direto. Linha 142 reviews.slice(0,10)
    //   -> TypeError "Cannot read properties of null". Same para qna.
    //   POST-FIX: defensive Array.isArray fallback.
    reviews = Array.isArray(r.reviews) ? r.reviews : [];
    qna = Array.isArray(q.qna) ? q.qna : [];
    related = Array.isArray(rel) ? rel : [];
  } catch {
    // notFound() so chamado se Api.product(slug) lancar (produto inexistente).
    // Reviews/qna/related TODOS tem fallback proprio -> nunca disparam aqui.
    notFound();
  }

  return (
    <div className="container mx-auto px-6 py-8">
      {/* FIX-WORKER-9 pass 3: JSON-LD para rich snippets Google */}
      <JsonLd data={productLd(product, reviews)} />
      <JsonLd data={breadcrumbLd(product)} />

      {/* FIX-WORKER-3 pass 2: breadcrumb com slash orfao quando produto nao tem category.
          Antes: "Catalogo / " (slash solto) quando category_slug=null.
          Agora: separador so renderiza se ha proxima entry; aria-label semantico. */}
      <nav aria-label="breadcrumb" className="text-sm text-white/40 mb-4">
        <Link href="/products" className="hover:text-white">Catalogo</Link>
        {product.category_slug && (
          <>
            <span className="mx-1.5 text-white/30" aria-hidden="true">/</span>
            <Link href={`/products?category=${product.category_slug}`} className="hover:text-white">{product.category_name}</Link>
          </>
        )}
        <span className="mx-1.5 text-white/30" aria-hidden="true">/</span>
        <span className="text-white/60">{product.title}</span>
      </nav>

      <div className="grid lg:grid-cols-3 gap-8 mb-12">
        <div className="lg:col-span-2 space-y-6">
          <div className="glass overflow-hidden">
            {product.cover_image_url ? (
              <div className="relative w-full aspect-video">
                <Image src={product.cover_image_url} alt={product.title}
                  fill priority sizes="(max-width: 768px) 100vw, 800px"
                  className="object-cover" />
              </div>
            ) : (
              <div className="w-full aspect-video bg-gradient-vibe/10 flex items-center justify-center">
                <div className="font-display font-bold text-7xl opacity-20">CAS</div>
              </div>
            )}
          </div>

          {/* FIX-WORKER-3: tabs funcionais (antes eram botoes decorativos sem onClick) */}
          <ProductTabs product={product} reviews={reviews.slice(0, 10)} qna={qna.slice(0, 8)} />
        </div>

        <aside className="space-y-6">
          {/* FIX-WORKER-15 pass 129: sticky SO em lg+ (layout 2-col).
              ANTES: sticky top-28 sempre ativo -> em mobile (single-col)
              aside tenta ficar 'fixa' durante scroll causando jumps visuais
              quando user rola pelas tabs longas (review/qna). Mobile UX
              tipico nao usa sticky em paineis full-width.
              AGORA: lg:sticky lg:top-28 - sticky so quando layout multi-col. */}
          <div className="glass p-6 lg:sticky lg:top-28">
            {/* MLB-NEW WORKER 16: combo selo Oficial+TopSeller (substitui badge Oficial standalone) */}
            <OfficialBadge isPlatformOwned={product.is_platform_owned} isTopSeller={product.is_top_seller} variant="pdp" />
            {/* MLB-3/8: destaque de vendas (Mercado Livre style) */}
            {product.sales_count > 50 && (
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-md bg-green-500/20 text-green-300 text-xs font-semibold mb-4 ml-2">
                +{Math.floor(Number(product.sales_count) / 10) * 10} vendidos
              </div>
            )}
            {/* MLB-NEW WORKER 16: badge "Vendido hoje/semana/mes" (urgencia + social proof) */}
            <RecentSaleBadge lastSaleAt={product.last_sale_at} variant="pdp" />
            {/* MLB-NEW WORKER 14: wishlist_count badge (social proof "X pessoas favoritaram") */}
            {Number(product.wishlist_count) >= 10 && (
              /* FIX-WORKER-15 pass 274 (a11y Heart decorativo):
                 Texto adjacente "X+ favoritaram" carrega semantica.
                 Heart icon decorativo - aria-hidden previne NVDA anunciar
                 "imagem Heart X+ favoritaram" redundante.
                 Pattern V8 a11y pass 255-256 (Star icons consolidated). */
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-md bg-pink-500/15 text-pink-300 text-xs font-semibold mb-4 ml-2 border border-pink-500/20">
                <Heart className="w-3 h-3 fill-pink-400 text-pink-400" aria-hidden="true" />
                {Math.floor(Number(product.wishlist_count) / 10) * 10}+ favoritaram
              </div>
            )}
            {/* FIX-WORKER-15 pass 4: text-2xl sm:text-3xl + break-words.
                Titulos longos (>40 chars) em 375px com text-3xl quebravam layout (overflow horizontal). */}
            <h1 className="font-display font-bold text-2xl sm:text-3xl mb-2 break-words">{product.title}</h1>
            {product.subtitle && <p className="text-white/60 mb-4">{product.subtitle}</p>}
            {/* FIX-WORKER-15 pass 4: flex-wrap evita overflow horizontal em 375px com
                review_count + sales_count grandes (ex: "4.8 (127 reviews) | 412 vendas"). */}
            <div className="flex items-center gap-3 mb-6 text-sm flex-wrap">
              <Star className="w-4 h-4 fill-yellow-400 text-yellow-400" aria-hidden="true" />
              <span className="font-semibold">{product.avg_rating ? Number(product.avg_rating).toFixed(1) : '-'}</span>
              <span className="text-white/40">({product.review_count} reviews)</span>
              <span className="text-white/40 hidden sm:inline">|</span>
              <span className="text-white/60">{product.sales_count} vendas</span>
            </div>
            <div className="text-4xl font-display font-bold text-magenta-glow mb-6">
              {product.is_free ? 'Gratis' : Api.formatBRL(product.price_cents)}
            </div>
            {/* MLB-NEW WORKER 17: parcelamento sem juros estilo Mercado Credito */}
            <Installments priceCents={product.price_cents} isFree={product.is_free} variant="pdp" />
            {/* MLB-15 WORKER 16 pass 166: badge 'Download imediato' inline (trust signal pre-buy) */}
            <div className="mt-2 mb-2">
              <InstantDownloadBadge hasPackage={!!product.package_url} variant="pdp" />
            </div>
            {/* MLB-16 WORKER 16 pass 167: badge desconto PIX 5% (incentivo pagamento instantaneo) */}
            <PixDiscountBadge priceCents={product.price_cents} isFree={product.is_free} variant="pdp" />
            <div className="flex gap-2 mb-3">
              <div className="flex-1">
                <AddToCart productId={product.id} isFree={product.is_free} />
              </div>
              <WishlistButton productId={product.id} />
            </div>

            {/* MLB-NEW WORKER 16: Pergunta rapida pre-purchase (Mercado Livre style) */}
            <AskQuickButton productId={product.id} />

            {/* MLB-12 (NEW): Avise-me se baixar (price drop alert) */}
            <div className="mt-3">
              <PriceAlertButton productId={product.id} currentPriceCents={product.price_cents} />
            </div>

            {/* MLB-NEW WORKER 16: Adicionar a comparacao (max 4) */}
            <CompareButton variant="pdp" product={{
              id: product.id, slug: product.slug, title: product.title,
              cover_image_url: product.cover_image_url, price_cents: product.price_cents,
              is_free: product.is_free,
            }} />

            {/* MLB-13 WORKER 16 pass 127: Compartilhar produto (WhatsApp/X/LinkedIn/Copy) */}
            <ShareButton title={product.title} productSlug={product.slug} productId={product.id} />

            {/* MLB-NEW WORKER 16: Trust Signals badges (Garantia + Suporte + Updates) */}
            <div className="mt-5 space-y-2.5 text-xs">
              {(product.warranty_days ?? 30) > 0 && (
                <div className="flex items-start gap-2.5 text-white/80">
                  <RefreshCw className="w-4 h-4 text-green-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <div className="font-semibold">Garantia de {product.warranty_days ?? 30} dias</div>
                    <div className="text-white/50 text-[11px]">Reembolso integral se nao funcionar conforme descrito</div>
                  </div>
                </div>
              )}
              {(product.support_response_hours ?? 48) > 0 && (
                <div className="flex items-start gap-2.5 text-white/80">
                  <Headphones className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <div className="font-semibold">Suporte em ate {product.support_response_hours ?? 48}h</div>
                    <div className="text-white/50 text-[11px]">Via Q&A do produto ou email do vendedor</div>
                  </div>
                </div>
              )}
              {(product.includes_updates ?? true) && (
                <div className="flex items-start gap-2.5 text-white/80">
                  <CheckCircle2 className="w-4 h-4 text-magenta flex-shrink-0 mt-0.5" />
                  <div>
                    <div className="font-semibold">Atualizacoes gratuitas</div>
                    <div className="text-white/50 text-[11px]">Receba novas versoes sem custo adicional</div>
                  </div>
                </div>
              )}
              {product.includes_install_support && (
                <div className="flex items-start gap-2.5 text-white/80">
                  <MessageCircle className="w-4 h-4 text-yellow-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <div className="font-semibold">Suporte na instalacao</div>
                    <div className="text-white/50 text-[11px]">Vendedor ajuda voce a configurar</div>
                  </div>
                </div>
              )}
            </div>

            {product.tech_stack?.length > 0 && (
              <div className="mt-6 pt-6 border-t border-white/10">
                <div className="text-xs text-white/40 uppercase mb-2">Tech Stack</div>
                <div className="flex flex-wrap gap-1.5">
                  {product.tech_stack.map((t: string) => (
                    <span key={t} className="text-xs px-2 py-1 rounded bg-white/5 font-mono">{t}</span>
                  ))}
                </div>
              </div>
            )}

            {product.store_slug && (
              <div className="mt-6 pt-6 border-t border-white/10 space-y-2">
                <Link href={`/seller/${product.store_slug}`} className="text-sm flex items-center gap-2 hover:text-magenta">
                  <Shield className="w-4 h-4" /> Vendido por <strong>{product.store_name}</strong>
                </Link>
                {/* MLB-NEW WORKER 16: badges inline do seller no PDP */}
                {product.reputation_tier && ['ouro','platinum','lider_platinum'].includes(product.reputation_tier) && (
                  <div className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-300 border border-yellow-500/30">
                    <Award className="w-3 h-3" /> {product.reputation_tier === 'lider_platinum' ? 'Lider Platinum' : product.reputation_tier === 'platinum' ? 'Platinum' : 'Ouro'}
                  </div>
                )}
                {/* MLB-17 WORKER 16 pass 169: Trust Mark destaque "Lider Premium / Verificado" */}
                <VerifiedSellerBadge reputationTier={product.reputation_tier} variant="pdp" />
              </div>
            )}

            <div className="mt-4 space-y-2 text-xs text-white/50">
              <div className="flex items-center gap-2"><Download className="w-3 h-3" /> Download imediato</div>
              <div className="flex items-center gap-2"><Clock className="w-3 h-3" /> Suporte por 365 dias</div>
              <div className="flex items-center gap-2"><Shield className="w-3 h-3" /> Validado por IA (QA score)</div>
            </div>
          </div>
        </aside>
      </div>

      {/* MLB-13 (NEW): Quem comprou isto, tambem comprou (collaborative filtering real) */}
      <AlsoBought slug={slug} />

      {/* MLB-6: Produtos relacionados (categoria-based fallback) */}
      {related.length > 0 && (
        <section className="mt-16">
          <h2 className="font-display font-bold text-2xl mb-6">Voce tambem pode gostar</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {related.map((p: any) => (
              <Link key={p.id} href={`/product/${p.slug}`} className="glass p-4 hover:scale-105 transition-transform group">
                <div className="flex gap-3">
                  {p.cover_image_url && (
                    <Image src={p.cover_image_url} alt={p.title}
                      width={64} height={64} sizes="64px"
                      className="w-16 h-16 object-cover rounded flex-shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="font-display font-semibold text-sm line-clamp-2 group-hover:text-magenta">{p.title}</div>
                    {/* FIX-WORKER-15 pass 252 (defensive nulls + mobile):
                        sales_count NULL renderizava "- null vendas" ou "-  vendas".
                        Produto novo (zero sales) tambem mostrava "- 0 vendas"
                        que e ruido cognitivo em mobile (espaco precioso 375px).
                        POST-FIX: so renderiza sales_count se > 0. Pattern W3 pass 7
                        + paridade product-card linha 102. */}
                    <div className="flex items-center gap-1 mt-1 text-xs">
                      <Star className="w-3 h-3 fill-yellow-400 text-yellow-400" aria-hidden="true" />
                      <span>{p.avg_rating ? Number(p.avg_rating).toFixed(1) : '-'}</span>
                      {Number(p.sales_count) > 0 && (
                        <span className="text-white/40">- {p.sales_count} vendas</span>
                      )}
                    </div>
                    <div className="font-display font-bold text-magenta-glow mt-1">{p.is_free ? 'Gratis' : Api.formatBRL(p.price_cents)}</div>
                    {/* MLB-NEW WORKER 17: parcelas em produto relacionado */}
                    <Installments priceCents={p.price_cents} isFree={p.is_free} variant="card" />
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* MLB-NEW WORKER 16: RecentlyViewedStrip horizontal scroll (so renderiza se logado + >=3 outros vistos) */}
      <RecentlyViewedStrip excludeId={product.id} />

      {/* MLB-14 WORKER 16 pass 131: tracking localStorage + Strip para GUESTS (nao logados) */}
      <TrackProductViewClient product={{
        slug: product.slug,
        title: product.title,
        cover_image_url: product.cover_image_url,
        price_cents: product.price_cents,
        is_free: product.is_free,
      }} />
      <RecentlyViewedGuest excludeSlug={product.slug} />
    </div>
  );
}
