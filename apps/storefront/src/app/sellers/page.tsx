import Link from 'next/link';
import Image from 'next/image';
import { Award, Star, Package } from 'lucide-react';
import type { Metadata } from 'next';

export const revalidate = 120;

// FIX-WORKER-9 pass 118: metadata explicita p/ /sellers (SEO listagem)
// FIX-WORKER-9 pass 519 (twitter card + locale + siteName paridade /promocoes pass 133):
//   PRE-FIX: 4 issues paridade lagged vs pages enriched neighbors:
//   1. NO twitter card - Twitter shares mostravam openGraph fallback
//      vs /promocoes pass 133 + /seller/[slug] pass 232 + /comparar pass 294
//      ja tinham twitter card explicit
//   2. openGraph SEM locale 'pt_BR' (paridade /cart/cloud-code-ilimitado/checkout)
//   3. openGraph SEM siteName 'Code & Agent Shop' (consistency branding)
//   4. NO robots explicit (default index:true mas defensive boa pratica para
//      listing pages indexable)
//   POST-FIX:
//   - twitter card 'summary_large_image' (paridade /promocoes pass 133)
//   - openGraph + locale + siteName (paridade outras pages)
//   - robots index:true + follow:true explicit (SEO listing page deve indexar)
//   Cadeia W9 metadata pages indexable cross-storefront completa
export const metadata: Metadata = {
  title: 'Vendedores Verificados | Code & Agent Shop',
  description: 'Conheca os desenvolvedores e vendedores oficiais do Code & Agent Shop. Compre direto de criadores verificados com reputacao publica, KYC validado e reviews reais.',
  alternates: { canonical: '/sellers' },
  openGraph: {
    type: 'website',
    url: 'https://cas.inovareinteligenciaartificial.com/sellers',
    title: 'Vendedores Verificados | Code & Agent Shop',
    description: 'Diretorio de desenvolvedores e vendedores oficiais com reputacao publica.',
    images: ['/opengraph-image'],
    locale: 'pt_BR',
    siteName: 'Code & Agent Shop',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Vendedores Verificados | Code & Agent Shop',
    description: 'Diretorio de desenvolvedores e vendedores oficiais com reputacao publica.',
    images: ['/opengraph-image'],
  },
  keywords: ['vendedores', 'desenvolvedores', 'criadores', 'marketplace', 'automacoes'],
  robots: { index: true, follow: true },
};

async function fetchSafe<T>(path: string): Promise<T | null> {
  try {
    const base = process.env.GATEWAY_URL || 'http://127.0.0.1:3002';
    const r = await fetch(`${base}${path}`, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

const TIER_BADGE: Record<string, string> = {
  iniciante:      'bg-gray-500/20 text-gray-300',
  bronze:         'bg-amber-700/20 text-amber-400',
  prata:          'bg-slate-400/20 text-slate-300',
  ouro:           'bg-yellow-500/20 text-yellow-300',
  platinum:       'bg-cyan-400/20 text-cyan-300',
  lider_platinum: 'bg-magenta/20 text-magenta-glow',
};

export default async function SellersPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const qs = new URLSearchParams({ limit: '60', sort: sp.sort || 'rep_desc', ...(sp.search ? { search: sp.search } : {}), ...(sp.tier ? { tier: sp.tier } : {}) });
  const data: any = await fetchSafe(`/api/sellers?${qs.toString()}`);
  const sellers = data?.sellers || [];

  return (
    <div className="container mx-auto px-6 py-8">
      <div className="flex items-end justify-between mb-8 flex-wrap gap-4">
        <div>
          <h1 className="font-display font-bold text-4xl mb-2">Vendedores</h1>
          <p className="text-white/60">{sellers.length} vendedor(es) ativos na plataforma</p>
        </div>
        <form className="flex gap-2">
          <input name="search" defaultValue={sp.search || ''} placeholder="Buscar vendedor..."
            className="px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-sm focus:border-magenta focus:outline-none" />
          <select name="tier" defaultValue={sp.tier || ''}
            className="glass px-3 py-2 text-sm bg-transparent text-white">
            <option value="">Todos os niveis</option>
            <option value="iniciante">Iniciante</option>
            <option value="bronze">Bronze</option>
            <option value="prata">Prata</option>
            <option value="ouro">Ouro</option>
            <option value="platinum">Platinum</option>
            <option value="lider_platinum">Lider Platinum</option>
          </select>
          <button type="submit" className="btn-primary text-sm">Filtrar</button>
        </form>
      </div>

      {sellers.length === 0 ? (
        <div className="glass p-12 text-center text-white/60">
          Nenhum vendedor encontrado para este filtro.
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {sellers.map((s: any) => (
            <Link key={s.id} href={`/seller/${s.store_slug}`} className="glass p-5 hover:scale-105 transition-transform group">
              <div className="flex items-start gap-3 mb-3">
                {/* FIX-WORKER-8 pass 2: <img> -> next/image */}
                {s.store_logo_url ? (
                  <div className="w-14 h-14 relative rounded-lg overflow-hidden flex-shrink-0">
                    <Image src={s.store_logo_url} alt={s.store_name || 'Vendedor'}
                      fill sizes="56px" className="object-cover" />
                  </div>
                ) : (
                  <div className="w-14 h-14 rounded-lg bg-gradient-vibe flex items-center justify-center font-display font-bold text-xl flex-shrink-0">
                    {s.store_name?.[0]}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="font-display font-bold truncate group-hover:text-magenta transition-colors">{s.store_name}</div>
                  <div className={`inline-block text-[10px] px-2 py-0.5 rounded mt-1 ${TIER_BADGE[s.reputation_tier] || TIER_BADGE.iniciante}`}>
                    <Award className="w-3 h-3 inline mr-1" /> {s.reputation_tier?.replace('_', ' ')}
                  </div>
                </div>
              </div>
              {s.store_description && (
                <p className="text-xs text-white/60 line-clamp-2 mb-3">{s.store_description}</p>
              )}
              <div className="flex items-center justify-between text-xs text-white/50 pt-3 border-t border-white/5">
                <span className="flex items-center gap-1"><Package className="w-3 h-3" /> {s.total_products_active || 0}</span>
                <span>{s.total_sales || 0} vendas</span>
                {s.avg_rating && <span className="flex items-center gap-1"><Star className="w-3 h-3 fill-yellow-400 text-yellow-400" aria-hidden="true" /> {Number(s.avg_rating).toFixed(1)}</span>}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
