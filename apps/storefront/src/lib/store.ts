'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type AuthState = {
  token: string | null;
  user: any | null;
  setAuth: (token: string, user: any) => void;
  clear: () => void;
};

export const useAuth = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      setAuth: (token, user) => set({ token, user }),
      clear: () => set({ token: null, user: null }),
    }),
    { name: 'cas_auth' }
  )
);

type UIState = {
  cartOpen: boolean;
  searchOpen: boolean;
  setCartOpen: (v: boolean) => void;
  setSearchOpen: (v: boolean) => void;
};

export const useUI = create<UIState>((set) => ({
  cartOpen: false,
  searchOpen: false,
  setCartOpen: (v) => set({ cartOpen: v }),
  setSearchOpen: (v) => set({ searchOpen: v }),
}));

/**
 * MLB-NEW WORKER 16: wishlist global state - evita N+1 quando renderizando
 * grids de produtos. Fetch once apos login, depois reads locais sincronos.
 * Mercado Livre: heart icon overlay em cada card -> precisa de O(1) lookup.
 */
type WishlistState = {
  ids: Set<string>;
  loaded: boolean;
  loadedToken: string | null;
  load: (token: string) => Promise<void>;
  add: (id: string) => void;
  remove: (id: string) => void;
  has: (id: string) => boolean;
  clear: () => void;
};
export const useWishlist = create<WishlistState>((set, get) => ({
  ids: new Set(),
  loaded: false,
  loadedToken: null,
  has: (id) => get().ids.has(id),
  add: (id) => set((s) => ({ ids: new Set([...s.ids, id]) })),
  remove: (id) => set((s) => {
    const next = new Set(s.ids);
    next.delete(id);
    return { ids: next };
  }),
  clear: () => set({ ids: new Set(), loaded: false, loadedToken: null }),
  load: async (token: string) => {
    // Evita re-fetch se ja carregou para esse token
    if (get().loaded && get().loadedToken === token) return;
    try {
      // import dinamico para evitar circular dep (api.ts importa nada do store)
      const { Api } = await import('./api');
      const r = await Api.api<{ products: Array<{ id: string }> }>('/products/wishlist', { auth: token, cache: 'no-store' });
      const ids = new Set<string>((r.products || []).map((p) => p.id));
      set({ ids, loaded: true, loadedToken: token });
    } catch {
      set({ loaded: true, loadedToken: token }); // gracioso, evita retry infinito
    }
  },
}));

/**
 * MLB-NEW WORKER 16: comparator drawer state.
 * Mercado Livre: usuario clica "Comparar" em ate 4 cards, drawer flutuante mostra
 * selecao e CTA "Comparar agora" -> /comparar?ids=uuid1,uuid2,uuid3.
 * Persistido em localStorage (cas_compare) para sobreviver refresh.
 */
export type CompareItem = {
  id: string;
  slug: string;
  title: string;
  cover_image_url?: string;
  price_cents: number;
  is_free?: boolean;
};
type CompareState = {
  items: CompareItem[];
  open: boolean;
  toggle: (p: CompareItem) => void;
  remove: (id: string) => void;
  clear: () => void;
  setOpen: (v: boolean) => void;
};
export const COMPARE_MAX = 4;
export const useCompare = create<CompareState>()(
  persist(
    (set, get) => ({
      items: [],
      open: false,
      toggle: (p) => {
        const cur = get().items;
        const has = cur.find((i) => i.id === p.id);
        if (has) {
          set({ items: cur.filter((i) => i.id !== p.id) });
        } else if (cur.length < COMPARE_MAX) {
          set({ items: [...cur, p], open: true });
        }
      },
      remove: (id) => set({ items: get().items.filter((i) => i.id !== id) }),
      clear: () => set({ items: [], open: false }),
      setOpen: (v) => set({ open: v }),
    }),
    { name: 'cas_compare' }
  )
);
