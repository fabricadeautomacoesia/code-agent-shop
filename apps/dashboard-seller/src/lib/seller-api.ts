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
    // FIX-WORKER-8 pass 1: anexar status no Error p/ caller distinguir 401/403/404/500
    // FIX-WORKER-5 pass 287: expose data structured (error/action_url/etc) p/ caller
    //   PRE-FIX: somente message + status. Backend retorna { error,action_url,extra }
    //   mas caller perdia fields p/ render UX rico (botoes inline, redirects).
    //   POST-FIX: e.data = data full payload. Caller pode acessar e.data.action_url
    //   e.data.error code etc. Pattern paridade adminFetch (dashboard-admin).
    const e: any = new Error(data?.message || data?.error || `http_${r.status}`);
    e.status = r.status;
    e.data = data;
    throw e;
  }
  // FIX-WORKER-8 pass 1: await explicito (Regra B padronizada cross-files)
  return r.status === 204 ? (null as T) : await r.json();
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
  if (!r.ok) {
    // FIX-WORKER-8 pass 1: extrair mensagem do body (same pattern sellerFetch)
    // upload tem erros especificos: invalid_mime, size_exceeded, quota_exceeded.
    // Antes: generico 'http_400' nao orientava seller a corrigir.
    let data: any = null;
    try { data = await r.json(); } catch {}
    const e: any = new Error(data?.message || data?.error || `http_${r.status}`);
    e.status = r.status;
    throw e;
  }
  return await r.json();
}

export const fmtBRL = (cents: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format((cents || 0) / 100);
export const fmtDate = (d: string) => new Date(d).toLocaleString('pt-BR');
