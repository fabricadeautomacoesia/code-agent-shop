import { Api } from '@/lib/api';
import { ProductCard } from '@/components/product-card';
import { ProductsSortSelect } from '@/components/products-sort-select';
import Link from 'next/link';
import type { Metadata } from 'next';

export const revalidate = 60;

// FIX-WORKER-9 pass 128: generateMetadata dinamico /products
// ANTES: layout.tsx tinha metadata estatica generica para todas variacoes
// /products?q=automacao /products?kind=ai_agent /products?free=true etc
// herdavam EXATAMENTE o mesmo title -> duplicate content penalty SEO.
// AGORA: per-query metadata + canonical preserva filtro principal.
const KIND_LABELS: Record<string, string> = {
  ai_agent: 'Agentes IA',
  n8n_workflow: 'Workflows n8n',
  automation: 'Automacoes',
  python_script: 'Scripts Python',
  node_script: 'Scripts Node.js',
  prompt_pack: 'Prompt Packs',
  template: 'Templates',
};

export async function generateMetadata({ searchParams }: { searchParams: Promise<Record<string, string>> }): Promise<Metadata> {
  const sp = await searchParams;
  const q = sp.q?.trim();
  const kind = sp.kind;
  const cat = sp.category;
  const free = sp.free === 'true';
  const tier = sp.tier;

  // Build title + description per filter combination
  let title = 'Catalogo';
  const titleParts: string[] = [];
  if (q) titleParts.push(`"${q}"`);
  if (kind && KIND_LABELS[kind]) titleParts.push(KIND_LABELS[kind]);
  if (cat) titleParts.push(cat.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()));
  if (free) titleParts.push('Gratis');
  if (tier) titleParts.push(`Vendedor ${tier}`);
  if (titleParts.length > 0) title = titleParts.join(' - ');

  const desc = q
    ? `Resultados para "${q}" - automacoes, agentes IA e workflows verificados na Code & Agent Shop.`
    : kind
      ? `${KIND_LABELS[kind] || 'Produtos'} verificados - QA automatizado via LLM + garantia 30 dias. Code & Agent Shop.`
      : 'Catalogo completo de automacoes, agentes IA, workflows n8n e scripts verificados. Code & Agent Shop.';

  // Canonical preserva filtro PRINCIPAL (kind > category > q) p/ evitar
  // index de variacoes infinitas (?sort=X &page=Y &min_price=Z)
  const canonicalParams = new URLSearchParams();
  if (kind) canonicalParams.set('kind', kind);
  else if (cat) canonicalParams.set('category', cat);
  else if (q) canonicalParams.set('q', q);
  const canonical = canonicalParams.toString()
    ? `/products?${canonicalParams.toString()}`
    : '/products';

  return {
    title: `${title} | Code & Agent Shop`,
    description: desc.slice(0, 160),
    alternates: { canonical },
    openGraph: {
      type: 'website',
      url: `https://cas.inovareinteligenciaartificial.com${canonical}`,
      title: `${title} - Code & Agent Shop`,
      description: desc.slice(0, 160),
      images: ['/opengraph-image'],
    },
    twitter: {
      card: 'summary_large_image',
      title: `${title} - Code & Agent Shop`,
      description: desc.slice(0, 160),
    },
    // Paginas 2+ ou filtros muito especificos -> noindex (evita thin content)
    robots: (sp.page && parseInt(sp.page, 10) > 1) || sp.sort
      ? { index: false, follow: true }
      : { index: true, follow: true },
  };
}

export default async function ProductsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const params = {
    q:           sp.q,
    category:    sp.category,
    kind:        sp.kind,
    min_price:   sp.min_price,
    max_price:   sp.max_price,
    free:        sp.free,
    tier:        sp.tier,
    sort:        sp.sort || 'relevance',
    page:        sp.page || '1',
    limit:       24,
  };

  let data: any = { results: [], total: 0, pages: 0 };
  try { data = await Api.search(params); } catch {}

  return (
    <div className="container mx-auto px-6 py-8">
      <div className="flex items-end justify-between mb-8">
        <div>
          <h1 className="font-display font-bold text-4xl mb-2">Catalogo</h1>
          <p className="text-white/60">
            {data.total} resultado{data.total !== 1 ? 's' : ''}
            {sp.q && <> para <span className="text-magenta">"{sp.q}"</span></>}
          </p>
        </div>
        {/* FIX-WORKER-16: era <form> sem submit handler -> dropdown nao funcionava.
            Agora ProductsSortSelect (Client Component) faz router.push onChange,
            preservando query params + reset page=1. Adicionado recent_sales option. */}
        <ProductsSortSelect current={params.sort} />
      </div>

      {data.results.length === 0 ? (
        <div className="glass p-12 text-center">
          <p className="text-xl mb-4">Nenhum produto encontrado.</p>
          <Link href="/products" className="text-magenta hover:underline">Limpar filtros</Link>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {data.results.map((p: any) => <ProductCard key={p.id} product={p} />)}
        </div>
      )}

      {data.pages > 1 && (
        <div className="mt-12 flex justify-center gap-2">
          {Array.from({ length: Math.min(data.pages, 10) }).map((_, i) => {
            const pNum = i + 1;
            const active = Number(params.page) === pNum;
            const qs = new URLSearchParams({ ...sp, page: String(pNum) }).toString();
            return (
              <Link key={pNum} href={`/products?${qs}`}
                className={`px-4 py-2 rounded-lg ${active ? 'bg-gradient-vibe text-white' : 'glass hover:border-white/30'}`}>
                {pNum}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
