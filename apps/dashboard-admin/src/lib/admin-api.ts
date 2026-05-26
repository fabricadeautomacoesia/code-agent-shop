'use client';

export async function adminFetch<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('cas_admin_token') : null;
  const r = await fetch(path.startsWith('/api') ? path : `/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers as any),
    },
    credentials: 'include',
    cache: 'no-store',
  });
  if (!r.ok) throw new Error(`http_${r.status}`);
  return r.status === 204 ? (null as T) : r.json();
}

export const fmtBRL = (cents: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format((cents || 0) / 100);

export const fmtDate = (d: string) => new Date(d).toLocaleString('pt-BR');
