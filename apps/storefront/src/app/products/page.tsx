import { Api } from '@/lib/api';
import { ProductCard } from '@/components/product-card';
import Link from 'next/link';

export const revalidate = 60;

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
        <form className="flex gap-2">
          <select name="sort" defaultValue={params.sort}
            className="glass px-4 py-2 text-sm bg-transparent text-white">
            <option value="relevance">Relevancia</option>
            <option value="sales">Mais vendidos</option>
            <option value="newest">Novos</option>
            <option value="price_asc">Menor preco</option>
            <option value="price_desc">Maior preco</option>
            <option value="rating">Melhor avaliados</option>
          </select>
        </form>
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
