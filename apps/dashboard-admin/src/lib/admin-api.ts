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
  if (!r.ok) {
    // FIX-WORKER-8 pass 1: tentar extrair mensagem do body (gateway envia
    // {error,message} JSON). Antes: Error('http_404') generico sem contexto.
    // Permite UI mostrar "Token expirado" em vez de "http_401".
    let msg = `http_${r.status}`;
    try { const j = await r.json(); if (j?.message) msg = j.message; else if (j?.error) msg = j.error; } catch {}
    const e: any = new Error(msg);
    e.status = r.status;
    throw e;
  }
  // FIX-WORKER-8 pass 1: await explicito (Regra B padronizada) - era
  // micro-optim retornar Promise mas confunde manutencao + caller .then
  // chains podem perder stack trace JSON parse.
  return r.status === 204 ? (null as T) : await r.json();
}

export const fmtBRL = (cents: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format((cents || 0) / 100);

export const fmtDate = (d: string) => new Date(d).toLocaleString('pt-BR');
