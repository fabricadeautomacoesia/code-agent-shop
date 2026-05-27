'use client';

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { ArrowDownUp } from 'lucide-react';

/**
 * MLB-NEW WORKER 16: dropdown de sort no /products.
 * Antes: <select> existia mas nao tinha onChange handler nem form submit ->
 * usuario mudava opcao e NADA acontecia.
 * Agora: onChange faz router.push preservando outros params (q, category, etc).
 *
 * Opcoes alinhadas com search-svc/server.js SORT_OPTIONS:
 *  relevance, sales, recent_sales, newest, price_asc, price_desc, rating
 */
export function ProductsSortSelect({ current }: { current: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = new URLSearchParams(sp.toString());
    next.set('sort', e.target.value);
    next.delete('page'); // reset page=1 ao mudar sort
    router.push(`${pathname}?${next.toString()}`);
  }

  return (
    <div className="flex items-center gap-2">
      <ArrowDownUp className="w-4 h-4 text-white/40" />
      <select
        name="sort"
        value={current}
        onChange={handleChange}
        aria-label="Ordenar produtos"
        className="glass px-4 py-2 text-sm bg-transparent text-white rounded-lg focus:border-magenta focus:outline-none cursor-pointer hover:bg-white/5 transition-colors"
      >
        <option value="relevance">Relevancia</option>
        <option value="sales">Mais vendidos</option>
        <option value="recent_sales">Vendendo agora</option>
        <option value="newest">Lancamentos</option>
        <option value="price_asc">Menor preco</option>
        <option value="price_desc">Maior preco</option>
        <option value="rating">Melhor avaliados</option>
      </select>
    </div>
  );
}
