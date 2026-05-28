'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { Clock, ChevronRight } from 'lucide-react';
import { Api } from '@/lib/api';
import { useAuth } from '@/lib/store';

/**
 * MLB-14 WORKER 16 pass 131: Recently Viewed para GUESTS (nao logados).
 *
 * RecentlyViewed/RecentlyViewedStrip existentes funcionam SO para users
 * autenticados (chamam /products/recently-viewed que requer JWT + DB lookup
 * em product_views table).
 *
 * Mercado Livre / Amazon mostram "Visto recentemente" mesmo para visitantes
 * anonimos (cookie / localStorage tracking client-side). Isso aumenta:
 *   - Tempo medio na sessao (cross-browse)
 *   - Taxa de retorno (lembranca visual ao reabrir tab)
 *   - Convers~ao (re-engagement em produtos vistos mas nao adquiridos)
 *
 * Estrategia (privacy-friendly):
 *   - localStorage 'cas:recent_products' = array de {slug, title, cover, price, viewedAt}
 *   - LIFO cap 12, dedup por slug (ultima vista move para topo)
 *   - Auto-expire 30 dias (mesmo TTL backend para consistencia visual)
 *   - SEM trip ao backend (100% client-side)
 *
 * Trigger:
 *   - PDP page chama trackProductView(product) em useEffect on mount
 *   - Componente renderiza apenas se user nao logado (logado usa backend)
 *   - excludeSlug remove produto atual do strip (evita "voce viu o que esta vendo")
 *   - min 3 produtos para renderizar (evita strip esqualida)
 */

const RECENT_KEY = 'cas:recent_products';
const RECENT_MAX = 12;
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias

export type RecentProduct = {
  slug: string;
  title: string;
  cover_image_url?: string | null;
  price_cents: number;
  is_free?: boolean;
  viewedAt: number; // Date.now()
};

export function trackProductView(product: {
  slug: string;
  title: string;
  cover_image_url?: string | null;
  price_cents: number;
  is_free?: boolean;
}) {
  if (typeof window === 'undefined') return;
  try {
    const now = Date.now();
    const raw = localStorage.getItem(RECENT_KEY);
    const list: RecentProduct[] = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) throw new Error('corrupted');
    // remove duplicate (slug) + filter TTL expirados
    const filtered = list.filter((p) =>
      p?.slug && p.slug !== product.slug && (now - (p.viewedAt || 0)) < TTL_MS
    );
    const next: RecentProduct[] = [
      {
        slug: product.slug,
        title: product.title,
        cover_image_url: product.cover_image_url || null,
        price_cents: product.price_cents,
        is_free: product.is_free,
        viewedAt: now,
      },
      ...filtered,
    ].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* quota / privacy mode - silent */ }
}

function loadRecent(): RecentProduct[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const now = Date.now();
    return arr.filter((p) =>
      p?.slug && p?.title && (now - (p?.viewedAt || 0)) < TTL_MS
    ).slice(0, RECENT_MAX);
  } catch { return []; }
}

/**
 * Strip horizontal de "Vistos recentemente" para GUESTS.
 * Renderiza null se: user logado, < 3 produtos, ou excludeSlug remove tudo.
 */
export function RecentlyViewedGuest({ excludeSlug }: { excludeSlug?: string }) {
  const { token } = useAuth();
  const [products, setProducts] = useState<RecentProduct[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setProducts(loadRecent());
    setLoaded(true);
  }, []);

  // Logado usa componente backend-based (mostra resultados precisos do BD)
  if (token) return null;
  if (!loaded) return null;

  const filtered = excludeSlug
    ? products.filter((p) => p.slug !== excludeSlug)
    : products;

  if (filtered.length < 3) return null;

  return (
    <section className="mt-16">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-display font-bold text-2xl flex items-center gap-2">
          <Clock className="w-5 h-5 text-magenta" aria-hidden="true" />
          Continuou navegando
        </h2>
      </div>
      <div className="flex gap-4 overflow-x-auto pb-4 snap-x snap-mandatory">
        {filtered.map((p) => (
          <Link
            key={p.slug}
            href={`/product/${p.slug}`}
            className="snap-start flex-shrink-0 w-36 sm:w-44 glass p-3 rounded-lg hover:scale-105 transition-transform group"
          >
            <div className="aspect-square relative rounded overflow-hidden bg-white/5 mb-2">
              {p.cover_image_url ? (
                <Image
                  src={p.cover_image_url}
                  alt={p.title}
                  fill
                  sizes="(max-width: 640px) 144px, 176px"
                  className="object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-white/20 font-display font-bold text-2xl">
                  CAS
                </div>
              )}
            </div>
            <div className="text-xs font-semibold line-clamp-2 group-hover:text-magenta transition-colors">
              {p.title}
            </div>
            <div className="text-xs text-magenta-glow mt-1 font-bold">
              {p.is_free ? 'Gratis' : Api.formatBRL(p.price_cents)}
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

/**
 * Helper: limpar historico (botao "Limpar" se quisermos UI no /conta)
 */
export function clearRecentProducts() {
  if (typeof window === 'undefined') return;
  try { localStorage.removeItem(RECENT_KEY); } catch {}
}
