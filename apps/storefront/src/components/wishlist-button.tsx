'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Heart, Loader2 } from 'lucide-react';
import { Api } from '@/lib/api';
import { useAuth, useWishlist } from '@/lib/store';

/**
 * MLB-NEW WORKER 16: variants 'pdp' (large button) e 'card' (overlay icon top-right).
 * Card variant usa useWishlist store (O(1) local lookup, fetch global once) -> evita N+1.
 */
export function WishlistButton({
  productId,
  variant = 'pdp',
}: {
  productId: string;
  variant?: 'pdp' | 'card';
}) {
  const router = useRouter();
  const { token } = useAuth();
  const { has, add, remove, load } = useWishlist();
  const inStore = has(productId);
  const [favorited, setFavorited] = useState(false);
  const [loading, setLoading] = useState(false);

  // PDP variant: legacy per-product /check (preserva fluxo W7 idempotency)
  // Card variant: usa store global - chama load() once + reads sincronos
  // FIX-WORKER-3 pass 6: load(token) sem callback - segundo useEffect com inStore
  // sincroniza automaticamente quando store update propaga (stale closure removido).
  useEffect(() => {
    if (!token) { setFavorited(false); return; }
    if (variant === 'card') {
      // Apenas dispara load - sincronizacao via segundo useEffect [inStore]
      load(token).catch(() => {});
      return;
    }
    Api.api<{ favorited: boolean }>(`/products/wishlist/${productId}/check`, { auth: token })
      .then((r) => setFavorited(r.favorited))
      .catch(() => {});
  }, [token, productId, variant]);

  // Sync local state com store quando card variant
  // (re-roda quando inStore muda apos load() completar - fixes stale closure)
  useEffect(() => {
    if (variant === 'card') setFavorited(inStore);
  }, [inStore, variant]);

  // FIX-WORKER-3 pass 6: feedback de erro para user (era silent console.error).
  // Network down / backend 500 antes nao retornava feedback visual.
  // User clicava, nada acontecia, e nao sabia se favoritou ou nao.
  const [errorFlash, setErrorFlash] = useState(false);

  async function toggle(e?: React.MouseEvent) {
    // Card overlay esta DENTRO de um <Link> wrapper - evita navegar para PDP
    if (e) { e.preventDefault(); e.stopPropagation(); }
    // FIX-WORKER-3 pass 4 (Pattern B): explicit guard anti-double-click.
    // setState eh async - 2 cliques em <16ms ambos passavam guard.
    // Mesmo bug que AddToCart pass 3 #2: optimistic flip 2x = volta visual
    // ao estado original + 2 POST/DELETE -> backend race.
    if (loading) return;
    if (!token) {
      // FIX-WORKER-3 pass 4 (Regra D): router.push soft-nav em vez de hard-redirect
      // (mesmo fix AddToCart pass 3 #4). Preserva history + state + ~50ms vs 500ms.
      const next = encodeURIComponent(window.location.pathname);
      router.push(`/login?next=${next}`);
      return;
    }
    // FIX-WORKER-3 pass 6: optimistic update com rollback em erro.
    // Antes: setFavorited APOS request OK -> UI demorada 200-400ms para mostrar resposta.
    // Agora: flip imediato + rollback se request falhar.
    const wasInWishlist = favorited;
    setLoading(true);
    setErrorFlash(false);
    // optimistic flip
    setFavorited(!wasInWishlist);
    if (variant === 'card') {
      wasInWishlist ? remove(productId) : add(productId);
    }
    try {
      if (wasInWishlist) {
        await Api.api(`/products/wishlist/${productId}`, { method: 'DELETE', auth: token });
      } else {
        await Api.api('/products/wishlist', { method: 'POST', auth: token, body: JSON.stringify({ product_id: productId }) });
      }
    } catch (err: any) {
      // FIX-WORKER-7: 404 not_in_wishlist no DELETE -> estado JA esta sincronizado
      // (acima setFavorited(!wasInWishlist) ja indica "nao favoritado")
      if (err?.status === 404 && err?.data?.error === 'not_in_wishlist') {
        // estado optimistic ja correto, nada a fazer
        return;
      }
      // FIX-WORKER-3 pass 6: rollback do optimistic + feedback visual
      console.error('[Wishlist]', err?.data?.error || err?.message);
      setFavorited(wasInWishlist);
      if (variant === 'card') {
        wasInWishlist ? add(productId) : remove(productId);
      }
      // Flash visual vermelho por 2s para indicar erro
      setErrorFlash(true);
      setTimeout(() => setErrorFlash(false), 2000);
    } finally { setLoading(false); }
  }

  // FIX-WORKER-3 pass 6: errorFlash override visual em ambos variants
  // (red shake-like ring por 2s quando request falha).
  const errorClasses = errorFlash ? 'ring-2 ring-red-500 animate-pulse' : '';

  if (variant === 'card') {
    return (
      <button onClick={toggle} disabled={loading}
        aria-label={favorited ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}
        aria-pressed={favorited}
        title={favorited ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}
        className={`absolute top-3 right-3 z-10 p-2 rounded-full backdrop-blur transition-all ${
          favorited
            ? 'bg-magenta/90 text-white shadow-lg shadow-magenta/40'
            : 'bg-black/40 text-white/80 hover:bg-magenta/80 hover:text-white'
        } disabled:opacity-50 ${errorClasses}`}>
        {loading
          ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
          : <Heart className={`w-3.5 h-3.5 ${favorited ? 'fill-white' : ''}`} aria-hidden="true" />}
      </button>
    );
  }

  return (
    /* FIX-WORKER-3 pass 6: PDP variant agora com aria-label + aria-pressed (era apenas title).
       title nao e anunciado por screen readers consistentemente. */
    <button onClick={toggle} disabled={loading}
      aria-label={favorited ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}
      aria-pressed={favorited}
      className={`p-2 rounded-lg border transition-all focus-visible:outline-2 focus-visible:outline-magenta ${
        favorited
          ? 'bg-magenta/20 border-magenta text-magenta-glow'
          : 'border-white/10 hover:border-white/30 text-white/60'
      } disabled:opacity-50 ${errorClasses}`}
      title={favorited ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}>
      {loading
        ? <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
        : <Heart className={`w-5 h-5 ${favorited ? 'fill-magenta' : ''}`} aria-hidden="true" />}
    </button>
  );
}
