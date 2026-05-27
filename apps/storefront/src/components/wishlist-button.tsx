'use client';

import { useEffect, useState } from 'react';
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
  const { token } = useAuth();
  const { has, add, remove, load } = useWishlist();
  const inStore = has(productId);
  const [favorited, setFavorited] = useState(false);
  const [loading, setLoading] = useState(false);

  // PDP variant: legacy per-product /check (preserva fluxo W7 idempotency)
  // Card variant: usa store global - chama load() once + reads sincronos
  useEffect(() => {
    if (!token) { setFavorited(false); return; }
    if (variant === 'card') {
      load(token).then(() => setFavorited(has(productId)));
      return;
    }
    Api.api<{ favorited: boolean }>(`/products/wishlist/${productId}/check`, { auth: token })
      .then((r) => setFavorited(r.favorited))
      .catch(() => {});
  }, [token, productId, variant]);

  // Sync local state com store quando card variant
  useEffect(() => {
    if (variant === 'card') setFavorited(inStore);
  }, [inStore, variant]);

  async function toggle(e?: React.MouseEvent) {
    // Card overlay esta DENTRO de um <Link> wrapper - evita navegar para PDP
    if (e) { e.preventDefault(); e.stopPropagation(); }
    if (!token) {
      window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
      return;
    }
    setLoading(true);
    try {
      if (favorited) {
        await Api.api(`/products/wishlist/${productId}`, { method: 'DELETE', auth: token });
        setFavorited(false);
        if (variant === 'card') remove(productId);
      } else {
        await Api.api('/products/wishlist', { method: 'POST', auth: token, body: JSON.stringify({ product_id: productId }) });
        setFavorited(true);
        if (variant === 'card') add(productId);
      }
    } catch (err: any) {
      // FIX-WORKER-7: 404 not_in_wishlist no DELETE -> sincroniza estado
      if (err?.status === 404 && (err?.data?.error === 'not_in_wishlist' || favorited)) {
        setFavorited(false);
        if (variant === 'card') remove(productId);
      } else {
        console.error('[Wishlist]', err?.data?.error || err?.message);
      }
    } finally { setLoading(false); }
  }

  if (variant === 'card') {
    return (
      <button onClick={toggle} disabled={loading}
        aria-label={favorited ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}
        title={favorited ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}
        className={`absolute top-3 right-3 z-10 p-2 rounded-full backdrop-blur transition-all ${
          favorited
            ? 'bg-magenta/90 text-white shadow-lg shadow-magenta/40'
            : 'bg-black/40 text-white/80 hover:bg-magenta/80 hover:text-white'
        } disabled:opacity-50`}>
        {loading
          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
          : <Heart className={`w-3.5 h-3.5 ${favorited ? 'fill-white' : ''}`} />}
      </button>
    );
  }

  return (
    <button onClick={toggle} disabled={loading}
      className={`p-2 rounded-lg border transition-all ${
        favorited
          ? 'bg-magenta/20 border-magenta text-magenta-glow'
          : 'border-white/10 hover:border-white/30 text-white/60'
      } disabled:opacity-50`}
      title={favorited ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}>
      {loading
        ? <Loader2 className="w-5 h-5 animate-spin" />
        : <Heart className={`w-5 h-5 ${favorited ? 'fill-magenta' : ''}`} />}
    </button>
  );
}
