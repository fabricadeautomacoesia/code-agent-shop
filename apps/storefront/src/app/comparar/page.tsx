import Link from 'next/link';
import { Check, X, GitCompare, Star, Award, Zap } from 'lucide-react';
import { Api } from '@/lib/api';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Comparar produtos - Code & Agent Shop',
  description: 'Compare ate 4 produtos lado a lado: preco, recursos, rating, tech stack.',
};

async function fetchSafe<T>(path: string): Promise<T | null> {
  try {
    const base = process.env.GATEWAY_URL || 'http://127.0.0.1:3002';
    const r = await fetch(`${base}${path}`, { cache: 'no-store' });
    if (!r.ok) return null;
    return r.json();
  } catch { return null; }
}

export default async function CompararPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const ids = sp.ids;

  if (!ids) return (
    <div className="container mx-auto px-6 py-16 max-w-2xl">
      <div className="glass p-12 text-center">
        <GitCompare className="w-16 h-16 mx-auto mb-4 text-magenta" />
        <h1 className="font-display font-bold text-3xl mb-3">Comparar produtos</h1>
        <p className="text-white/60 mb-6">
          Adicione produtos para comparar via URL: <code className="bg-white/5 px-2 py-1 rounded text-xs">?ids=uuid1,uuid2,uuid3</code>
        </p>
        <Link href="/products" className="btn-primary inline-block">Ver catalogo</Link>
      </div>
    </div>
  );

  const data: any = await fetchSafe(`/api/products/compare?ids=${ids}`);
  const products = data?.products || [];

  if (products.length < 2) return (
    <div className="container mx-auto px-6 py-16 max-w-2xl text-center">
      <h1 className="font-display font-bold text-2xl mb-3 text-red-400">Comparacao invalida</h1>
      <p className="text-white/60 mb-6">Selecione pelo menos 2 produtos validos.</p>
      <Link href="/products" className="btn-primary">Voltar ao catalogo</Link>
    </div>
  );

  // Calcular features comuns (union de tech_stack)
  const allTech = new Set<string>();
  products.forEach((p: any) => (p.tech_stack || []).forEach((t: string) => allTech.add(t)));
  const allTechArr = Array.from(allTech).sort();

  return (
    <div className="container mx-auto px-6 py-8">
      <Link href="/" className="text-sm text-white/60 hover:text-white">&larr; Voltar</Link>

      <div className="mt-4 mb-8">
        <h1 className="font-display font-bold text-4xl mb-2 flex items-center gap-3">
          <GitCompare className="w-9 h-9 text-magenta" />
          Comparando {products.length} produtos
        </h1>
        <p className="text-white/60">Analise lado a lado para decidir a melhor opcao</p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className="text-left p-3 w-40 sticky left-0 bg-cyber-dark"></th>
              {products.map((p: any) => (
                <th key={p.id} className="p-3 min-w-[240px]">
                  <Link href={`/product/${p.slug}`} className="block">
                    {p.cover_image_url ? (
                      <img src={p.cover_image_url} alt={p.title} className="w-full h-32 object-cover rounded-lg mb-2" />
                    ) : (
                      <div className="w-full h-32 bg-gradient-vibe/10 rounded-lg mb-2" />
                    )}
                    <div className="font-display font-bold text-base hover:text-magenta line-clamp-2 text-left">{p.title}</div>
                  </Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            <tr>
              <td className="p-3 font-semibold text-white/60 sticky left-0 bg-cyber-dark">Preco</td>
              {products.map((p: any) => (
                <td key={p.id} className="p-3">
                  {p.flash_promo_active && (
                    <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-orange-500/20 text-orange-300 text-[10px] font-bold mb-1">
                      <Zap className="w-3 h-3" /> -{p.flash_promo_discount_pct}%
                    </div>
                  )}
                  <div className="font-display font-bold text-xl text-magenta-glow">
                    {p.is_free ? 'Gratis' : Api.formatBRL(p.price_cents)}
                  </div>
                  <div className="text-xs text-white/40">{p.license_kind?.replace(/_/g, ' ')}</div>
                </td>
              ))}
            </tr>
            <tr>
              <td className="p-3 font-semibold text-white/60 sticky left-0 bg-cyber-dark">Avaliacao</td>
              {products.map((p: any) => (
                <td key={p.id} className="p-3">
                  <div className="flex items-center gap-1">
                    <Star className="w-4 h-4 fill-yellow-400 text-yellow-400" />
                    <span className="font-bold">{p.avg_rating ? Number(p.avg_rating).toFixed(1) : '-'}</span>
                    <span className="text-xs text-white/40">({p.review_count})</span>
                  </div>
                </td>
              ))}
            </tr>
            <tr>
              <td className="p-3 font-semibold text-white/60 sticky left-0 bg-cyber-dark">Vendas</td>
              {products.map((p: any) => (
                <td key={p.id} className="p-3 font-mono">{p.sales_count}</td>
              ))}
            </tr>
            <tr>
              <td className="p-3 font-semibold text-white/60 sticky left-0 bg-cyber-dark">Categoria</td>
              {products.map((p: any) => <td key={p.id} className="p-3 text-xs">{p.category_name || '-'}</td>)}
            </tr>
            <tr>
              <td className="p-3 font-semibold text-white/60 sticky left-0 bg-cyber-dark">Tipo</td>
              {products.map((p: any) => <td key={p.id} className="p-3"><code className="text-xs">{p.kind}</code></td>)}
            </tr>
            <tr>
              <td className="p-3 font-semibold text-white/60 sticky left-0 bg-cyber-dark">Vendedor</td>
              {products.map((p: any) => (
                <td key={p.id} className="p-3 text-xs">
                  {p.is_platform_owned ? (
                    <span className="inline-flex items-center gap-1 text-magenta-glow"><Award className="w-3 h-3" /> Oficial CAS</span>
                  ) : p.store_name ? (
                    <Link href={`/seller/${p.store_slug}`} className="hover:text-magenta">{p.store_name}</Link>
                  ) : '-'}
                </td>
              ))}
            </tr>
            <tr>
              <td className="p-3 font-semibold text-white/60 sticky left-0 bg-cyber-dark">Tempo instalacao</td>
              {products.map((p: any) => <td key={p.id} className="p-3 text-xs">{p.estimated_install_min ? `${p.estimated_install_min} min` : '-'}</td>)}
            </tr>
            {allTechArr.map((tech) => (
              <tr key={tech}>
                <td className="p-3 font-mono text-xs text-white/60 sticky left-0 bg-cyber-dark">{tech}</td>
                {products.map((p: any) => (
                  <td key={p.id} className="p-3 text-center">
                    {(p.tech_stack || []).includes(tech)
                      ? <Check className="w-5 h-5 text-green-400 inline" />
                      : <X className="w-5 h-5 text-white/20 inline" />}
                  </td>
                ))}
              </tr>
            ))}
            <tr>
              <td className="p-3 sticky left-0 bg-cyber-dark"></td>
              {products.map((p: any) => (
                <td key={p.id} className="p-3 text-center">
                  <Link href={`/product/${p.slug}`} className="btn-primary text-xs inline-block">Ver detalhes</Link>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
