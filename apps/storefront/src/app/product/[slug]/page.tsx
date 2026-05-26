import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Star, Award, Download, Shield, Clock, Tag } from 'lucide-react';
import { Api } from '@/lib/api';
import { QnaForm } from '@/components/qna-form';
import { AddToCart } from '@/components/add-to-cart';
import { WishlistButton } from '@/components/wishlist-button';
import { QnaUpvote } from '@/components/qna-upvote';

export const revalidate = 30;

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  let product: any, reviews: any[] = [], qna: any[] = [];
  try {
    const p = await Api.product(slug);
    product = p.product;
    const [r, q] = await Promise.all([
      Api.reviews(slug).catch(() => ({ reviews: [] })),
      Api.qna(slug).catch(() => ({ qna: [] })),
    ]);
    reviews = r.reviews; qna = q.qna;
  } catch {
    notFound();
  }

  return (
    <div className="container mx-auto px-6 py-8">
      <div className="text-sm text-white/40 mb-4">
        <Link href="/products" className="hover:text-white">Catalogo</Link> /{' '}
        {product.category_slug && <Link href={`/products?category=${product.category_slug}`} className="hover:text-white">{product.category_name}</Link>}
      </div>

      <div className="grid lg:grid-cols-3 gap-8 mb-12">
        <div className="lg:col-span-2 space-y-6">
          <div className="glass overflow-hidden">
            {product.cover_image_url ? (
              <img src={product.cover_image_url} alt={product.title} className="w-full aspect-video object-cover" />
            ) : (
              <div className="w-full aspect-video bg-gradient-vibe/10 flex items-center justify-center">
                <div className="font-display font-bold text-7xl opacity-20">CAS</div>
              </div>
            )}
          </div>

          <div className="glass p-6">
            <div className="flex border-b border-white/10 -mx-6 px-6 mb-6">
              {['Visao Geral','Pre-requisitos','Changelog','Reviews','Q&A'].map((t, i) => (
                <button key={i} className={`px-4 py-3 text-sm font-medium ${i === 0 ? 'text-magenta border-b-2 border-magenta -mb-px' : 'text-white/60'}`}>{t}</button>
              ))}
            </div>
            <div className="prose prose-invert max-w-none">
              <h3 className="font-display text-2xl">Sobre este produto</h3>
              <p className="whitespace-pre-line text-white/80">{product.description}</p>
              {product.install_instructions && (
                <>
                  <h3 className="font-display text-xl mt-8">Instrucoes de instalacao</h3>
                  <pre className="bg-black/40 p-4 rounded-lg overflow-x-auto text-sm">{product.install_instructions}</pre>
                </>
              )}
              {product.api_keys_required?.length > 0 && (
                <>
                  <h3 className="font-display text-xl mt-8">APIs necessarias</h3>
                  <ul>{product.api_keys_required.map((k: string) => <li key={k}><code>{k}</code></li>)}</ul>
                </>
              )}
            </div>
          </div>

          <div className="glass p-6">
            <h3 className="font-display font-bold text-xl mb-4">Perguntas & Respostas</h3>
            {qna.length > 0 ? (
              <div className="space-y-4 mb-6">
                {qna.slice(0, 8).map((q) => (
                  <div key={q.id} className="border-b border-white/5 pb-4 last:border-0">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1">
                        <div className="font-semibold text-sm mb-1">Q: {q.question}</div>
                        {q.answer
                          ? <div className="text-sm text-white/70 pl-4 border-l-2 border-magenta mt-1">R: {q.answer}</div>
                          : <div className="text-xs text-white/40 italic mt-1">Aguardando resposta do vendedor...</div>}
                      </div>
                      <QnaUpvote qnaId={q.id} initialCount={q.upvote_count || 0} />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-white/60 mb-6">Seja o primeiro a perguntar sobre este produto.</p>
            )}
            <QnaForm productId={product.id} />
          </div>

          {reviews.length > 0 && (
            <div className="glass p-6">
              <h3 className="font-display font-bold text-xl mb-4">Avaliacoes</h3>
              <div className="space-y-4">
                {reviews.slice(0, 10).map((r) => (
                  <div key={r.id} className="border-b border-white/5 pb-4 last:border-0">
                    <div className="flex items-center gap-2 mb-1">
                      {Array.from({ length: r.rating }).map((_, i) => <Star key={i} className="w-4 h-4 fill-yellow-400 text-yellow-400" />)}
                      <span className="font-semibold text-sm">{r.title}</span>
                      {r.is_verified_purchase && <span className="text-[10px] px-1.5 py-0.5 bg-green-500/20 text-green-400 rounded">COMPRA VERIFICADA</span>}
                    </div>
                    <p className="text-sm text-white/70">{r.body}</p>
                    <div className="text-xs text-white/40 mt-1">{r.buyer_name}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <aside className="space-y-6">
          <div className="glass p-6 sticky top-28">
            {product.is_platform_owned && (
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-magenta/20 text-magenta-glow text-xs font-semibold mb-4">
                <Award className="w-3 h-3" /> Produto Oficial CAS
              </div>
            )}
            {/* MLB-3/8: destaque de vendas (Mercado Livre style) */}
            {product.sales_count > 50 && (
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-md bg-green-500/20 text-green-300 text-xs font-semibold mb-4 ml-2">
                +{Math.floor(Number(product.sales_count) / 10) * 10} vendidos
              </div>
            )}
            <h1 className="font-display font-bold text-3xl mb-2">{product.title}</h1>
            {product.subtitle && <p className="text-white/60 mb-4">{product.subtitle}</p>}
            <div className="flex items-center gap-3 mb-6 text-sm">
              <Star className="w-4 h-4 fill-yellow-400 text-yellow-400" />
              <span className="font-semibold">{product.avg_rating ? Number(product.avg_rating).toFixed(1) : '-'}</span>
              <span className="text-white/40">({product.review_count} reviews)</span>
              <span className="text-white/40">|</span>
              <span className="text-white/60">{product.sales_count} vendas</span>
            </div>
            <div className="text-4xl font-display font-bold text-magenta-glow mb-6">
              {product.is_free ? 'Gratis' : Api.formatBRL(product.price_cents)}
            </div>
            <div className="flex gap-2 mb-3">
              <div className="flex-1">
                <AddToCart productId={product.id} isFree={product.is_free} />
              </div>
              <WishlistButton productId={product.id} />
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
              <div className="mt-6 pt-6 border-t border-white/10">
                <Link href={`/seller/${product.store_slug}`} className="text-sm flex items-center gap-2 hover:text-magenta">
                  <Shield className="w-4 h-4" /> Vendido por <strong>{product.store_name}</strong>
                </Link>
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
    </div>
  );
}
