'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Search, X, TrendingUp } from 'lucide-react';
import { Api } from '@/lib/api';
import { Dialog } from './dialog';

/**
 * Autocomplete de busca com debounce 200ms e sugestoes via /api/search/autocomplete.
 * Mostra tambem trending searches quando input esta vazio (foco).
 *
 * FIX-WORKER-3 pass 12: REFATORADO para usar <Dialog> wrapper (pass 9).
 *
 * REMOVIDO ~10 linhas pre-fix:
 * - useEffect ESC key listener manual (linhas 23-26 pre-fix)
 * - <div outer> + <button backdrop> + <div role=dialog> manual
 * - aria-modal + aria-label manual no JSX
 * - inputRef focus mount manual (Dialog cuida via focus auto-mount)
 *
 * Pos-fix: <Dialog open={true}> declarativo - component renderizado
 * condicionalmente pelo parent (Nav: {searchOpen && <SearchAutocomplete>}).
 *
 * BONUS pass 9: focus auto-mount no PRIMEIRO focusable (input search).
 * Pre-fix tinha inputRef.current?.focus() manual (mesmo resultado).
 * Bonus extra: return-to-opener (botao Search no Nav) on close.
 *
 * VARIANT diferenca vs CartDrawer/AskQuick:
 * - centered = items-center default, MAS este modal usa items-start pt-24
 * - Solucao: nao usar variant - className override outer-container
 *   (wrapper aceita className mas eh INNER container)
 * - Trade-off: este consumer precisa flag novo OU manter wrapping fora
 * - Decisao: usar Dialog SEM title (header rico) + className "items-start" override
 *   nao funciona porque outer flex eh propriedade do Dialog interno
 * - ALTERNATIVA: usar variant='centered' + aceitar pt-24 via CSS calc
 *
 * Decisao FINAL: refator MINIMAL - aproveitar wrapper APENAS para
 * Escape/scroll-lock/focus/role=dialog. Manter posicionamento custom
 * via className override (max-w-2xl mt-24 mt-from-top).
 */
export function SearchAutocomplete({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [trending, setTrending] = useState<any[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // FIX-WORKER-3 pass 12: useEffect ESC + body lock REMOVIDOS (Dialog cuida).
  // Mantido SO o trending fetch + debounce autocomplete (logica de negocio).
  useEffect(() => {
    Api.trending().then((r) => setTrending(r.trending.slice(0, 6))).catch(() => {});
  }, []);

  useEffect(() => {
    if (q.length < 2) { setSuggestions([]); return; }
    const t = setTimeout(() => {
      Api.autocomplete(q).then((r) => setSuggestions(r.suggestions)).catch(() => {});
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  // Mantem inputRef.current?.focus() manual: Dialog wrapper foca PRIMEIRO
  // focusable - como input estar visivel pos-mount, vai focar automatico.
  // Defensive: explicit focus garante mesmo se ordem DOM mudar futuramente.
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (q.trim()) {
      router.push(`/products?q=${encodeURIComponent(q.trim())}`);
      onClose();
    }
  }

  return (
    <Dialog
      open={true}
      onClose={onClose}
      ariaLabel="Busca de produtos"
      variant="centered"
      zIndex={60}
      closeLabel="Fechar busca"
      className="relative glass-strong w-full max-w-2xl rounded-2xl overflow-hidden mt-[-30vh] sm:mt-[-25vh]"
    >
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
              <TrendingUp className="w-3 h-3" aria-hidden="true" /> Mais buscados na semana
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
    </Dialog>
  );
}
