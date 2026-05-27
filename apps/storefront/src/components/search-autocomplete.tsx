'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Search, X, TrendingUp } from 'lucide-react';
import { Api } from '@/lib/api';

/**
 * Autocomplete de busca com debounce 200ms e sugestoes via /api/search/autocomplete.
 * Mostra tambem trending searches quando input esta vazio (foco).
 */
export function SearchAutocomplete({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [trending, setTrending] = useState<any[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    Api.trending().then((r) => setTrending(r.trending.slice(0, 6))).catch(() => {});
    // ESC fecha
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (q.length < 2) { setSuggestions([]); return; }
    const t = setTimeout(() => {
      Api.autocomplete(q).then((r) => setSuggestions(r.suggestions)).catch(() => {});
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (q.trim()) {
      router.push(`/products?q=${encodeURIComponent(q.trim())}`);
      onClose();
    }
  }

  return (
    // FIX-WORKER-3 pass 8 (a11y): wrapper passivo + backdrop semantico button
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-24 px-4">
      <button type="button" aria-label="Fechar busca"
        onClick={onClose}
        className="absolute inset-0 bg-black/80 backdrop-blur-sm cursor-default" />
      {/* role=dialog + aria-labelledby. searchbox role no input com aria-label */}
      <div role="dialog" aria-modal="true" aria-label="Busca de produtos"
        className="relative glass-strong w-full max-w-2xl rounded-2xl overflow-hidden">
        <form onSubmit={submit} className="flex items-center p-4 border-b border-white/10">
          <Search className="w-5 h-5 text-white/40 mr-3" aria-hidden="true" />
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)}
            aria-label="Buscar produtos"
            placeholder="Buscar agentes IA, workflows n8n, scripts..."
            className="flex-1 bg-transparent outline-none text-lg" />
          <button type="button" onClick={onClose} aria-label="Fechar busca"
            className="p-2 hover:bg-white/5 rounded focus-visible:outline-2 focus-visible:outline-magenta">
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </form>

        <div className="max-h-96 overflow-y-auto">
          {suggestions.length > 0 ? (
            <div className="p-2">
              <div className="text-xs text-white/40 uppercase px-3 py-2">Sugestoes</div>
              {suggestions.map((s) => (
                <Link key={s.slug} href={`/product/${s.slug}`} onClick={onClose}
                  className="block px-3 py-2 hover:bg-white/5 rounded-lg text-sm">
                  <span className="text-magenta">{s.title}</span>
                </Link>
              ))}
            </div>
          ) : q.length < 2 && trending.length > 0 ? (
            <div className="p-2">
              <div className="text-xs text-white/40 uppercase px-3 py-2 flex items-center gap-2">
                <TrendingUp className="w-3 h-3" /> Mais buscados na semana
              </div>
              {trending.map((t) => (
                <Link key={t.query_normalized} href={`/products?q=${encodeURIComponent(t.query_normalized)}`} onClick={onClose}
                  className="block px-3 py-2 hover:bg-white/5 rounded-lg text-sm flex items-center justify-between">
                  <span>{t.query_normalized}</span>
                  <span className="text-xs text-white/40">{t.count} buscas</span>
                </Link>
              ))}
            </div>
          ) : q.length >= 2 ? (
            <div className="p-8 text-center text-white/40 text-sm">
              Nenhuma sugestao. Pressione Enter para buscar.
            </div>
          ) : null}
        </div>

        <div className="border-t border-white/10 px-4 py-3 text-xs text-white/40 flex items-center justify-between">
          <span>Enter para buscar - ESC para fechar</span>
          <span>{q.length >= 2 ? `Buscando "${q}"` : 'Digite pelo menos 2 caracteres'}</span>
        </div>
      </div>
    </div>
  );
}
