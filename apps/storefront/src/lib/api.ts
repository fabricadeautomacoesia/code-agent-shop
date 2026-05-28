/**
 * Cliente API para o gateway (V8 21.1).
 * Acesso server-side via GATEWAY_URL, client-side via /api/* (Next rewrites).
 *
 * FIX-WORKER-8 pass 2: 4 bugs corrigidos aplicando Regra B + E (W3/W8 pass 1):
 * 1. Regra B violada linha 63 - r.json() sem await em success path:
 *    JSON malformed em 200 propaga ao caller que espera T (nao Promise<T>).
 *    Caller .then crash + stack trace perdido.
 * 2. Regra E parcial linha 60 - extraia data.error mas NAO data.message:
 *    Auth-svc retorna {message: "Email ja cadastrado"} em validacao negocio.
 *    friendly-errors.ts recebia "http_400" generico em vez da mensagem real.
 * 3. Refresh loop guard sem validacao access_token: backend retorna 200
 *    com {access_token: ''} (corner case) -> retry dispara 401 again -> loop.
 *    FIX: validar data?.access_token truthy antes de retry.
 * 4. cache + next.revalidate juntos: Next 16 warn "cache + revalidate mutex".
 *    FIX: mutex - usa init.cache OU next.revalidate, nao ambos.
 */
const SERVER_BASE = process.env.GATEWAY_URL || 'http://127.0.0.1:3002';
const isServer = typeof window === 'undefined';

export class ApiError extends Error {
  status: number;
  data: any;
  constructor(status: number, message: string, data?: any) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

// FIX bug 3: tipo explicito _retry para evitar 'as any' cast (type-safe guard)
type ApiInit = RequestInit & {
  auth?: string;
  cache?: RequestCache;
  revalidate?: number;
  _retry?: boolean;
};

export async function api<T = any>(path: string, init: ApiInit = {}): Promise<T> {
  const base = isServer ? SERVER_BASE : '';
  const url = `${base}${path.startsWith('/api') ? path : '/api' + path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> || {}),
  };
  if (init.auth) headers['Authorization'] = `Bearer ${init.auth}`;

  // FIX bug 4: mutex cache vs next.revalidate (Next 16 warning)
  // Se revalidate definido, usar next:{revalidate} + cache:undefined.
  // Se cache definido, usar cache + next:undefined.
  // Caller passa UM dos dois, nunca ambos.
  const fetchOpts: RequestInit = {
    ...init,
    headers,
    credentials: 'include',
  };
  if (init.revalidate !== undefined) {
    (fetchOpts as any).next = { revalidate: init.revalidate };
  } else if (init.cache) {
    fetchOpts.cache = init.cache;
  }

  const r = await fetch(url, fetchOpts);

  // Auto-refresh: se 401 token_expired e tem auth, tentar refresh silencioso
  if (r.status === 401 && init.auth && !init._retry && !isServer) {
    try {
      const refreshUrl = `/api/auth/refresh`;
      const rr = await fetch(refreshUrl, { method: 'POST', credentials: 'include' });
      if (rr.ok) {
        // FIX bug 1: await dentro do try (Regra B) + validacao
        let data: any = null;
        try { data = await rr.json(); } catch {}
        // FIX bug 3: validar access_token truthy (anti-loop em backend bug)
        if (data?.access_token && typeof data.access_token === 'string') {
          // notifica zustand store
          try {
            const { useAuth } = await import('./store');
            const { user } = useAuth.getState();
            useAuth.getState().setAuth(data.access_token, user);
          } catch {}
          // retry com novo token (_retry: true previne recursao infinita)
          return api<T>(path, { ...init, auth: data.access_token, _retry: true });
        }
      }
    } catch { /* ignore - cai no throw ApiError abaixo */ }
  }

  if (!r.ok) {
    let data: any = null;
    try { data = await r.json(); } catch {}
    // FIX bug 2 (Regra E): extrair message E error E error_pt_br (fallback chain).
    // Auth-svc/order-svc/product-svc usam .message (negocio human-readable).
    // errorHandler shared usa .error (codigo machine-readable).
    // Notification template variables: error_pt_br (pt-BR localizado opcional).
    const message = data?.message || data?.error_pt_br || data?.error || `http_${r.status}`;
    throw new ApiError(r.status, message, data);
  }
  if (r.status === 204) return null as T;
  // FIX bug 1 (Regra B): await explicito em success path
  // Se body malformed em 200, rejeita DENTRO da funcao (caller catch normal)
  // em vez de propagar Promise rejected
  return await r.json();
}

export const Api = {
  api: api,
  search: (params: Record<string, any>) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([_, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)])
    ).toString();
    return api<{ results: any[]; total: number; pages: number; duration_ms: number }>(`/search?${qs}`);
  },
  autocomplete: (q: string) => api<{ suggestions: { title: string; slug: string }[] }>(`/search/autocomplete?q=${encodeURIComponent(q)}`),
  categories:  () => api<{ categories: any[] }>('/search/categories'),
  trending:    () => api<{ trending: { query_normalized: string; count: number }[] }>('/search/trending'),
  product:     (slug: string) => api<{ product: any }>(`/products/${slug}`, { revalidate: 60 }),
  reviews:     (slug: string) => api<{ reviews: any[] }>(`/products/${slug}/reviews`),
  qna:         (slug: string) => api<{ qna: any[] }>(`/products/${slug}/qna`),
  cart:        (token: string) => api<{ cart: any }>('/orders/cart', { auth: token }),
  cartAdd:     (token: string, product_id: string, quantity = 1) =>
    api('/orders/cart/items', { method: 'POST', auth: token, body: JSON.stringify({ product_id, quantity }) }),
  cartDel:     (token: string, item_id: string) =>
    api(`/orders/cart/items/${item_id}`, { method: 'DELETE', auth: token }),
  cartSetQty:  (token: string, item_id: string, quantity: number) =>
    api(`/orders/cart/items/${item_id}`, { method: 'PATCH', auth: token, body: JSON.stringify({ quantity }) }),
  cartLoyaltyRedeem: (token: string, points: number) =>
    api<{ ok: boolean; applied_points: number; discount_cents: number; cap_cents: number; balance: number }>(
      '/orders/cart/loyalty/redeem', { method: 'POST', auth: token, body: JSON.stringify({ points }) }),
  cartLoyaltyClear:  (token: string) =>
    api('/orders/cart/loyalty/redeem', { method: 'DELETE', auth: token }),
  cartCoupon:  (token: string, code: string) =>
    api('/orders/cart/coupon', { method: 'POST', auth: token, body: JSON.stringify({ code }) }),
  checkout:    (token: string, payment_method: 'pix'|'credit_card'|'boleto', installment_count?: number) =>
    api('/orders/checkout', { method: 'POST', auth: token, body: JSON.stringify({ payment_method, installment_count }) }),
  status:      () => api<any>('/aiops/status'),
  login:       (email: string, password: string, totp?: string) =>
    api<{ access_token: string; user: any; requires_2fa?: boolean }>('/auth/login', {
      method: 'POST', body: JSON.stringify({ email, password, totp })
    }),
  register:    (body: any) => api('/auth/register', { method: 'POST', body: JSON.stringify(body) }),
  me:          (token: string) => api<{ user: any }>('/auth/me', { auth: token }),
  formatBRL:   (cents: number) =>
    new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format((cents || 0) / 100),
  /* FIX-WORKER-2 pass 316: defensive date helper paridade cross-app pass 315.
     PRE-FIX: pages usavam new Date(d).toLocaleString diretamente - sem isNaN
     guard. created_at=null/undef/invalid -> 'Invalid Date' UX feio.
     POST-FIX: helper centralizado:
     - null/undef -> '-'
     - invalid date string -> '-'
     - valid -> toLocaleString('pt-BR') com opts opcional
     Cobre /conta/pedidos/[id], pontos/page, comparar, etc consumers. */
  formatDate: (d: string | null | undefined, opts?: Intl.DateTimeFormatOptions): string => {
    if (!d) return '-';
    const t = new Date(d).getTime();
    if (isNaN(t)) return '-';
    return new Date(d).toLocaleString('pt-BR', opts);
  },
  /**
   * MLB-NEW WORKER 17: calcula parcelamento sem juros padrao Mercado Livre.
   * Regra: max 12x, parcela minima R$5 (500 cents). Retorna { n, perCents } ou null se < min.
   */
  installments: (cents: number, max = 12, minParcelaCents = 500) => {
    if (!cents || cents <= 0) return null;
    let n = max;
    while (n > 1 && Math.floor(cents / n) < minParcelaCents) n--;
    if (n < 2) return null;
    const perCents = Math.floor(cents / n);
    return { n, perCents };
  },
};
