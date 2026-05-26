'use client';

export async function sellerFetch<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('cas_seller_token') : null;
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
  if (!r.ok) {
    let data: any = null;
    try { data = await r.json(); } catch {}
    throw new Error(data?.message || `http_${r.status}`);
  }
  return r.status === 204 ? (null as T) : r.json();
}

export async function sellerUpload(path: string, file: File): Promise<any> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('cas_seller_token') : null;
  const fd = new FormData();
  fd.append('file', file);
  const r = await fetch(path.startsWith('/api') ? path : `/api${path}`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: 'include',
    body: fd,
  });
  if (!r.ok) throw new Error(`http_${r.status}`);
  return r.json();
}

export const fmtBRL = (cents: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format((cents || 0) / 100);
export const fmtDate = (d: string) => new Date(d).toLocaleString('pt-BR');
