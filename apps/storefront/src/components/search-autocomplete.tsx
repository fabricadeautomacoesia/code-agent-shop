'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Search, X, TrendingUp, Clock } from 'lucide-react';
import { Api } from '@/lib/api';
import { Dialog } from './dialog';

// FIX-WORKER-16 pass 122 MLB FEATURE: historico de buscas recentes
// Pattern Mercado Livre - usuario volta ao search bar, ve ultimas 8 buscas.
// Persistido em localStorage (client-side, sem trip ao backend) para privacy.
// Dedup + LIFO + cap 8. Click busca direto / X individual remove / "Limpar" zera.
const RECENT_KEY = 'cas:recent_searches';
const RECENT_MAX = 8;

function loadRecent(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(s => typeof s === 'string').slice(0, RECENT_MAX) : [];
  } catch { return []; }
}

function pushRecent(q: string) {
  if (typeof window === 'undefined') return;
  const trimmed = q.trim().slice(0, 80);
  if (trimmed.length < 2) return;
  try {
    const prev = loadRecent().filter(s => s.toLowerCase() !== trimmed.toLowerCase());
    const next = [trimmed, ...prev].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* quota / privacy mode - silent */ }
}

function removeRecent(q: string): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const next = loadRecent().filter(s => s !== q);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    return next;
  } catch { return loadRecent(); }
}

function clearRecent() {
  if (typeof window === 'undefined') return;
  try { localStorage.removeItem(RECENT_KEY); } catch {}
}

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
  // FIX-WORKER-16 pass 122 MLB: state recent searches (loaded from localStorage)
  const [recent, setRecent] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // FIX-WORKER-3 pass 12: useEffect ESC + body lock REMOVIDOS (Dialog cuida).
  // Mantido SO o trending fetch + debounce autocomplete (logica de negocio).
  useEffect(() => {
    Api.trending().then((r) => setTrending(r.trending.slice(0, 6))).catch(() => {});
    // FIX-WORKER-16 pass 122 MLB: hidrata recent searches do localStorage
    setRecent(loadRecent());
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
      // FIX-WORKER-16 pass 122 MLB: persiste busca no localStorage antes de navegar
      pushRecent(q.trim());
      router.push(`/products?q=${encodeURIComponent(q.trim())}`);
      onClose();
    }
  }

  // FIX-WORKER-16 pass 122 MLB: click direto numa busca recente
  function clickRecent(query: string) {
    pushRecent(query); // refresh LRU - move to top
    router.push(`/products?q=${encodeURIComponent(query)}`);
    onClose();
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
        ) : q.length < 2 ? (
          <div className="p-2">
            {/* FIX-WORKER-16 pass 122 MLB: secao "Buscas Recentes" - localStorage history */}
            {recent.length > 0 && (
              <>
                <div className="text-xs text-white/40 uppercase px-3 py-2 flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <Clock className="w-3 h-3" aria-hidden="true" /> Buscas recentes
                  </span>
                  <button type="button" onClick={() => { clearRecent(); setRecent([]); }}
                    className="text-[10px] text-white/40 hover:text-magenta transition-colors normal-case">
                    Limpar
                  </button>
                </div>
                {recent.map((rq) => (
                  <div key={rq}
                    className="flex items-center justify-between px-3 py-2 hover:bg-white/5 rounded-lg text-sm group">
                    <button type="button" onClick={() => clickRecent(rq)}
                      className="flex-1 text-left flex items-center gap-2 truncate">
                      <Clock className="w-3 h-3 text-white/30 flex-shrink-0" aria-hidden="true" />
                      <span className="truncate">{rq}</span>
                    </button>
                    <button type="button" onClick={() => setRecent(removeRecent(rq))}
                      aria-label={`Remover busca recente: ${rq}`}
                      className="p-1 hover:bg-white/10 rounded opacity-50 group-hover:opacity-100 transition-opacity">
                      <X className="w-3 h-3" aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </>
            )}
            {trending.length > 0 && (
              <>
                <div className="text-xs text-white/40 uppercase px-3 py-2 mt-1 flex items-center gap-2">
                  <TrendingUp className="w-3 h-3" aria-hidden="true" /> Mais buscados na semana
                </div>
                {trending.map((t) => (
                  <Link key={t.query_normalized} href={`/products?q=${encodeURIComponent(t.query_normalized)}`}
                    onClick={() => { pushRecent(t.query_normalized); onClose(); }}
                    className="block px-3 py-2 hover:bg-white/5 rounded-lg text-sm flex items-center justify-between">
                    <span>{t.query_normalized}</span>
                    <span className="text-xs text-white/40">{t.count} buscas</span>
                  </Link>
                ))}
              </>
            )}
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
