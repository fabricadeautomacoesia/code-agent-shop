'use client';

import { useEffect, useState } from 'react';
import { Heart, Loader2 } from 'lucide-react';
import { Api } from '@/lib/api';
import { useAuth } from '@/lib/store';

export function WishlistButton({ productId }: { productId: string }) {
  const { token } = useAuth();
  const [favorited, setFavorited] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!token) return;
    Api.api<{ favorited: boolean }>(`/products/wishlist/${productId}/check`, { auth: token })
      .then((r) => setFavorited(r.favorited))
      .catch(() => {});
  }, [token, productId]);

  async function toggle() {
    if (!token) {
      window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
      return;
    }
    setLoading(true);
    try {
      if (favorited) {
        await Api.api(`/products/wishlist/${productId}`, { method: 'DELETE', auth: token });
        setFavorited(false);
      } else {
        await Api.api('/products/wishlist', { method: 'POST', auth: token, body: JSON.stringify({ product_id: productId }) });
        setFavorited(true);
      }
    } catch (e: any) {
      alert('Erro: ' + (e.data?.message || e.message));
    } finally { setLoading(false); }
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
