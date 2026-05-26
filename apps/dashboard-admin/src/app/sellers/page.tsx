'use client';

import { useEffect, useState } from 'react';
import { adminFetch, fmtDate } from '@/lib/admin-api';
import { Ban, CheckCircle, ArrowUp } from 'lucide-react';

export default function SellersPage() {
  const [pending, setPending] = useState<any[]>([]);
  const [error, setError] = useState('');

  async function load() {
    try { const r = await adminFetch<{ sellers: any[] }>('/sellers/admin/pending-kyc'); setPending(r.sellers); }
    catch (e: any) { setError(e.message); }
  }
  useEffect(() => { load(); }, []);

  async function suspend(id: string) {
    const reason = prompt('Motivo da suspensao:');
    if (!reason) return;
    await adminFetch(`/sellers/admin/${id}/suspend`, { method: 'POST', body: JSON.stringify({ reason }) });
    load();
  }
  async function promoteB(id: string) {
    if (!confirm('Promover este seller para Classe B (Cloud Code Ilimitado)?')) return;
    await adminFetch(`/sellers/admin/${id}/promote-class-b`, { method: 'POST', body: JSON.stringify({ sla_days: 15 }) });
    load();
  }

  return (
    <div>
      <h1 className="font-display font-bold text-4xl mb-2">Sellers</h1>
      <p className="text-white/60 mb-8">Gestao de vendedores e KYC pendente</p>

      {error && <div className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg mb-4">{error}</div>}

      <div className="glass p-6">
        <h2 className="font-display font-bold text-xl mb-4">KYC Pendente ({pending.length})</h2>
        {pending.length === 0 ? (
          <p className="text-white/60">Nenhum KYC aguardando.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-white/40 uppercase border-b border-white/10">
              <tr><th className="py-2">Loja</th><th>Email</th><th>Classe</th><th>Criado em</th><th className="text-right">Acoes</th></tr>
            </thead>
            <tbody>
              {pending.map((s) => (
                <tr key={s.id} className="border-b border-white/5 hover:bg-white/5">
                  <td className="py-3">{s.store_name}</td>
                  <td className="text-white/60">{s.email}</td>
                  <td><span className="px-2 py-0.5 rounded bg-white/5 text-xs">{s.seller_class}</span></td>
                  <td className="text-white/40 text-xs">{fmtDate(s.created_at)}</td>
                  <td className="text-right space-x-2">
                    {s.seller_class === 'class_a' && (
                      <button onClick={() => promoteB(s.id)} className="text-magenta hover:underline text-xs inline-flex items-center gap-1">
                        <ArrowUp className="w-3 h-3" /> Classe B
                      </button>
                    )}
                    <button onClick={() => suspend(s.id)} className="text-red-400 hover:underline text-xs inline-flex items-center gap-1">
                      <Ban className="w-3 h-3" /> Suspender
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
