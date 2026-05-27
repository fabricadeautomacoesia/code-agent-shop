'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Heart } from 'lucide-react';
import { Api } from '@/lib/api';
import { useAuth } from '@/lib/store';

/**
 * MLB style: Heart icon no Nav com contador real de favoritos.
 * - Renderiza null se nao logado (zero noise).
 * - Polling 60s para refresh automatico.
 * - Hover -> link para /conta/favoritos.
 */
export function WishlistBadge() {
  const { token } = useAuth();
  const [count, setCount] = useState<number>(0);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!token) { setLoaded(true); setCount(0); return; }
    let alive = true;
    async function load() {
      try {
        const r = await Api.api<{ count: number }>('/products/wishlist', { auth: token!, cache: 'no-store' });
        if (alive) setCount(r.count || 0);
      } catch { /* silent */ }
      finally { if (alive) setLoaded(true); }
    }
    load();
    const i = setInterval(load, 60000);
    return () => { alive = false; clearInterval(i); };
  }, [token]);

  if (!token || !loaded) return null;

  return (
    <Link href="/conta/favoritos" aria-label={`Favoritos (${count})`}
      className="p-2 rounded-lg hover:bg-white/5 transition-colors relative group">
      <Heart className={`w-5 h-5 transition-colors ${count > 0 ? 'text-magenta fill-magenta/30' : 'text-white/80 group-hover:text-magenta'}`} />
      {count > 0 && (
        <span className="absolute -top-1 -right-1 bg-magenta text-white text-[10px] rounded-full w-5 h-5 flex items-center justify-center font-bold shadow-lg shadow-magenta/40">
          {count > 9 ? '9+' : count}
        </span>
      )}
    </Link>
  );
}
