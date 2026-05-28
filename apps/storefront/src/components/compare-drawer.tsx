'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { GitCompare, X, ChevronDown, ChevronUp, ArrowRight, Trash2 } from 'lucide-react';
import { useCompare, COMPARE_MAX } from '@/lib/store';
import { Api } from '@/lib/api';

/**
 * MLB-NEW WORKER 16: floating drawer flutuante bottom-right que mostra produtos
 * selecionados para comparacao. Hidden quando 0 items. Collapsivel para nao
 * obstruir o conteudo. CTA principal -> /comparar?ids=uuid1,uuid2,...
 *
 * Mercado Livre exibe widget similar fixed bottom para reduzir friction:
 * usuario nao precisa lembrar quais marcou, basta clicar "Comparar agora".
 */
export function CompareDrawer() {
  const { items, remove, clear } = useCompare();
  const [mounted, setMounted] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => setMounted(true), []);
  if (!mounted || items.length === 0) return null;

  const compareUrl = `/comparar?ids=${items.map((i) => i.id).join(',')}`;
  const canCompare = items.length >= 2;

  return (
    <div className="fixed bottom-4 right-4 z-[70] w-[min(380px,calc(100vw-2rem))] glass-strong rounded-2xl shadow-2xl border border-magenta/30 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 bg-magenta/10 border-b border-white/10">
        <div className="flex items-center gap-2">
          <GitCompare className="w-4 h-4 text-magenta-glow" />
          <span className="text-sm font-semibold">Comparar ({items.length}/{COMPARE_MAX})</span>
        </div>
        {/* FIX-WORKER-1 pass 158 (a11y): type='button' + aria-expanded + aria-hidden icons */}
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? 'Expandir comparacao' : 'Recolher comparacao'}
            aria-expanded={!collapsed}
            className="p-1 rounded hover:bg-white/10 transition-colors focus-visible:outline-2 focus-visible:outline-magenta">
            {collapsed ? <ChevronUp className="w-4 h-4" aria-hidden="true" /> : <ChevronDown className="w-4 h-4" aria-hidden="true" />}
          </button>
          <button type="button" onClick={clear}
            aria-label={`Limpar comparacao (${items.length} ${items.length === 1 ? 'item' : 'itens'})`}
            className="p-1 rounded hover:bg-red-500/20 hover:text-red-300 transition-colors focus-visible:outline-2 focus-visible:outline-red-400">
            <Trash2 className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      {!collapsed && (
        <>
          <ul className="divide-y divide-white/5 max-h-64 overflow-y-auto">
            {items.map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-4 py-2.5">
                {p.cover_image_url ? (
                  /* FIX-WORKER-18 pass 4: sizes="40px" + loading="lazy".
                     Sem sizes Next.js servia full-resolution image para thumb 40x40 = waste.
                     Drawer eh offscreen ate aberto, lazy nao bloqueia render inicial. */
                  <Image src={p.cover_image_url} alt={p.title} width={40} height={40}
                    sizes="40px" loading="lazy"
                    className="w-10 h-10 object-cover rounded flex-shrink-0" />
                ) : (
                  <div className="w-10 h-10 bg-gradient-vibe/10 rounded flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <Link href={`/product/${p.slug}`} className="block text-xs font-medium line-clamp-1 hover:text-magenta">
                    {p.title}
                  </Link>
                  <div className="text-[11px] text-magenta-glow font-mono">
                    {p.is_free ? 'Gratis' : Api.formatBRL(p.price_cents)}
                  </div>
                </div>
                <button type="button" onClick={() => remove(p.id)}
                  aria-label={`Remover ${p.title} da comparacao`}
                  className="p-1 rounded hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-magenta">
                  <X className="w-3.5 h-3.5 text-white/60" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>

          <div className="p-3 border-t border-white/10 bg-black/20">
            {canCompare ? (
              <Link href={compareUrl}
                className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl bg-gradient-vibe text-white text-sm font-semibold hover:opacity-90 transition-opacity">
                Comparar agora <ArrowRight className="w-4 h-4" />
              </Link>
            ) : (
              <div className="text-center text-xs text-white/50 py-2">
                Adicione +{2 - items.length} produto{2 - items.length > 1 ? 's' : ''} para comparar
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
