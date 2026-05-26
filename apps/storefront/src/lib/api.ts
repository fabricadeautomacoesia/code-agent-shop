/**
 * Cliente API para o gateway (V8 21.1).
 * Acesso server-side via GATEWAY_URL, client-side via /api/* (Next rewrites).
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

export async function api<T = any>(
  path: string,
  init: RequestInit & { auth?: string; cache?: RequestCache; revalidate?: number } = {}
): Promise<T> {
  const base = isServer ? SERVER_BASE : '';
  const url = `${base}${path.startsWith('/api') ? path : '/api' + path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> || {}),
  };
  if (init.auth) headers['Authorization'] = `Bearer ${init.auth}`;

  const r = await fetch(url, {
    ...init,
    headers,
    credentials: 'include',
    cache: init.cache,
    next: init.revalidate ? { revalidate: init.revalidate } : undefined,
  });

  if (!r.ok) {
    let data: any = null;
    try { data = await r.json(); } catch {}
    throw new ApiError(r.status, data?.error || `http_${r.status}`, data);
  }
  if (r.status === 204) return null as T;
  return r.json();
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
  cartCoupon:  (token: string, code: string) =>
    api('/orders/cart/coupon', { method: 'POST', auth: token, body: JSON.stringify({ code }) }),
  checkout:    (token: string, payment_method: 'pix'|'credit_card'|'boleto') =>
    api('/orders/checkout', { method: 'POST', auth: token, body: JSON.stringify({ payment_method }) }),
  status:      () => api<any>('/aiops/status'),
  login:       (email: string, password: string, totp?: string) =>
    api<{ access_token: string; user: any; requires_2fa?: boolean }>('/auth/login', {
      method: 'POST', body: JSON.stringify({ email, password, totp })
    }),
  register:    (body: any) => api('/auth/register', { method: 'POST', body: JSON.stringify(body) }),
  me:          (token: string) => api<{ user: any }>('/auth/me', { auth: token }),
  formatBRL:   (cents: number) =>
    new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format((cents || 0) / 100),
};
