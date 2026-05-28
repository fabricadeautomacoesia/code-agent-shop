import Link from 'next/link';
import Image from 'next/image';
import { Check, X, GitCompare, Star, Award, Zap } from 'lucide-react';
import { Api } from '@/lib/api';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Comparar produtos - Code & Agent Shop',
  description: 'Compare ate 4 produtos lado a lado: preco, recursos, rating, tech stack.',
  // FIX-WORKER-9 pass 4: noindex (comparacoes user-generated nao devem ser indexadas) + canonical base
  // sem isso: ?ids=uuid1,uuid2 e ?ids=uuid2,uuid1 viram URLs duplicadas no Google (explosao combinatorial)
  robots: { index: false, follow: true },
  alternates: { canonical: '/comparar' },
};

// FIX-WORKER-3 pass 8: fetchCompare retorna detalhe do error (consume W7 pass 6).
// Antes: fetchSafe descartava body de 400/404 -> mensagem generica "Comparacao invalida"
// Agora: backend errors granulares (invalid_ids/products_not_found/insufficient_products)
// chegam ao frontend para mensagem clara e CTA apropriado.
type CompareResult = {
  ok: true;
  products: any[];
  count: number;
  missing_ids?: string[];
  warning_truncated?: string;
} | {
  ok: false;
  status: number;
  error: string;
  message: string;
  invalid_count?: number;
  found?: number;
  requested_count?: number;
  missing_ids?: string[];
};

async function fetchCompare(ids: string): Promise<CompareResult> {
  try {
    const base = process.env.GATEWAY_URL || 'http://127.0.0.1:3002';
    const r = await fetch(`${base}/api/products/compare?ids=${ids}`, { cache: 'no-store' });
    const body = await r.json().catch(() => ({}));
    if (r.ok) return { ok: true, ...body };
    return { ok: false, status: r.status, error: body.error || 'unknown', message: body.message || 'Erro desconhecido', ...body };
  } catch (e: any) {
    return { ok: false, status: 0, error: 'network', message: 'Falha de rede ao buscar produtos' };
  }
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

  const result = await fetchCompare(ids);

  // FIX-WORKER-3 pass 8: error path com mensagens granulares por tipo de erro
  if (!result.ok) {
    const errorMessages: Record<string, { title: string; hint: string }> = {
      invalid_ids: {
        title: 'IDs invalidos',
        hint: `Os identificadores enviados nao sao UUIDs validos${result.invalid_count ? ` (${result.invalid_count} invalidos)` : ''}. Verifique o link.`,
      },
      products_not_found: {
        title: 'Produtos indisponiveis',
        hint: `Nenhum dos ${result.requested_count || 'produtos solicitados'} esta disponivel para comparacao. Podem ter sido removidos ou despublicados.`,
      },
      insufficient_products: {
        title: 'Produtos insuficientes',
        hint: `Apenas ${result.found || 0} produto(s) valido(s) foram encontrados. Comparacao precisa de pelo menos 2 produtos disponiveis.`,
      },
      min_2_products: {
        title: 'Selecione pelo menos 2',
        hint: 'A comparacao precisa de no minimo 2 produtos. Adicione mais via lista de catalogo.',
      },
      network: {
        title: 'Falha de conexao',
        hint: 'Nao foi possivel buscar os produtos. Tente novamente em alguns segundos.',
      },
    };
    const e = errorMessages[result.error] || { title: 'Erro inesperado', hint: result.message };
    return (
      <div className="container mx-auto px-6 py-16 max-w-2xl text-center">
        <GitCompare className="w-16 h-16 mx-auto mb-4 text-white/30" />
        <h1 className="font-display font-bold text-2xl mb-3 text-red-400">{e.title}</h1>
        <p className="text-white/60 mb-2">{e.hint}</p>
        {result.missing_ids && result.missing_ids.length > 0 && (
          <p className="text-xs text-white/40 mb-6 font-mono">
            Indisponiveis: {result.missing_ids.slice(0, 3).join(', ')}{result.missing_ids.length > 3 ? ` +${result.missing_ids.length - 3}` : ''}
          </p>
        )}
        <Link href="/products" className="btn-primary inline-block">Voltar ao catalogo</Link>
      </div>
    );
  }

  const products = result.products;

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

      {/* FIX-WORKER-3 pass 8: avisos de partial success (W7 pass 6 backend response) */}
      {(result.missing_ids && result.missing_ids.length > 0) || result.warning_truncated ? (
        <div className="mb-6 p-4 rounded-lg bg-yellow-500/10 border border-yellow-500/30 text-sm">
          {result.missing_ids && result.missing_ids.length > 0 && (
            <div className="text-yellow-200">
              <strong>Aviso:</strong> {result.missing_ids.length} produto(s) solicitado(s) nao puderam ser carregados (removidos ou despublicados).
            </div>
          )}
          {result.warning_truncated && (
            <div className="text-yellow-200 mt-1">{result.warning_truncated}</div>
          )}
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className="text-left p-3 w-40 sticky left-0 bg-cyber-dark z-10"></th>
              {products.map((p: any) => (
                <th key={p.id} className="p-3 min-w-[240px]">
                  {/* FIX-WORKER-8 pass 3: cover h-24 sm:h-32 (responsive em 375px com hscroll) +
                      hover group state no Link inteiro (era so no texto) -> imagem tambem reage */}
                  <Link href={`/product/${p.slug}`} className="block group">
                    {p.cover_image_url ? (
                      <div className="w-full h-24 sm:h-32 relative rounded-lg overflow-hidden mb-2 group-hover:ring-2 group-hover:ring-magenta/50 transition-all">
                        <Image src={p.cover_image_url} alt={p.title || 'Produto'}
                          fill sizes="240px" className="object-cover group-hover:scale-105 transition-transform duration-300" />
                      </div>
                    ) : (
                      <div className="w-full h-24 sm:h-32 bg-gradient-vibe/10 rounded-lg mb-2" />
                    )}
                    <div className="font-display font-bold text-base group-hover:text-magenta transition-colors line-clamp-2 text-left">{p.title}</div>
                  </Link>
                </th>
              ))}
            </tr>
          </thead>
          {/* FIX-WORKER-8 pass 3: hover state em todas as data rows
              (era flat sem affordance visual de scan) */}
          <tbody className="divide-y divide-white/5 [&_tr:hover]:bg-white/[0.02] [&_tr:hover_td.sticky]:bg-[#0a0b0f]">
            <tr>
              <td className="p-3 font-semibold text-white/60 sticky left-0 bg-cyber-dark z-10">Preco</td>
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
              <td className="p-3 font-semibold text-white/60 sticky left-0 bg-cyber-dark z-10">Avaliacao</td>
              {products.map((p: any) => (
                <td key={p.id} className="p-3">
                  <div className="flex items-center gap-1">
                    <Star className="w-4 h-4 fill-yellow-400 text-yellow-400" aria-hidden="true" />
                    <span className="font-bold">{p.avg_rating ? Number(p.avg_rating).toFixed(1) : '-'}</span>
                    <span className="text-xs text-white/40">({p.review_count})</span>
                  </div>
                </td>
              ))}
            </tr>
            <tr>
              <td className="p-3 font-semibold text-white/60 sticky left-0 bg-cyber-dark z-10">Vendas</td>
              {products.map((p: any) => (
                <td key={p.id} className="p-3 font-mono">{p.sales_count}</td>
              ))}
            </tr>
            <tr>
              <td className="p-3 font-semibold text-white/60 sticky left-0 bg-cyber-dark z-10">Categoria</td>
              {products.map((p: any) => <td key={p.id} className="p-3 text-xs">{p.category_name || '-'}</td>)}
            </tr>
            <tr>
              <td className="p-3 font-semibold text-white/60 sticky left-0 bg-cyber-dark z-10">Tipo</td>
              {products.map((p: any) => <td key={p.id} className="p-3"><code className="text-xs">{p.kind}</code></td>)}
            </tr>
            <tr>
              <td className="p-3 font-semibold text-white/60 sticky left-0 bg-cyber-dark z-10">Vendedor</td>
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
              <td className="p-3 font-semibold text-white/60 sticky left-0 bg-cyber-dark z-10">Tempo instalacao</td>
              {products.map((p: any) => <td key={p.id} className="p-3 text-xs">{p.estimated_install_min ? `${p.estimated_install_min} min` : '-'}</td>)}
            </tr>
            {allTechArr.map((tech) => (
              <tr key={tech}>
                <td className="p-3 font-mono text-xs text-white/60 sticky left-0 bg-cyber-dark z-10">{tech}</td>
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
              <td className="p-3 sticky left-0 bg-cyber-dark z-10"></td>
              {products.map((p: any) => (
                <td key={p.id} className="p-3 text-center">
                  {/* FIX-WORKER-8 pass 3: btn-primary tem px-6 py-3, conflito com text-xs.
                      Substituido por btn-ghost menor (border + hover) - CTA secundario
                      (cell action, nao primary action da page) */}
                  <Link href={`/product/${p.slug}`}
                    className="inline-flex items-center justify-center gap-1 px-3 py-2 rounded-lg text-xs font-semibold border border-magenta/40 bg-magenta/10 hover:bg-magenta/20 hover:border-magenta transition-colors">
                    Ver detalhes
                  </Link>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
