'use client';

import { useEffect, useState } from 'react';
import { adminFetch, fmtBRL, fmtDate } from '@/lib/admin-api';
import { Check, X, Send } from 'lucide-react';

export default function PayoutsPage() {
  const [list, setList] = useState<any[]>([]);
  const [error, setError] = useState('');

  async function load() {
    try { const r = await adminFetch<{ payouts: any[] }>('/sellers/admin/payouts/pending'); setList(r.payouts); }
    catch (e: any) { setError(e.message); }
  }
  useEffect(() => { load(); }, []);

  async function approve(id: string) {
    await adminFetch(`/sellers/admin/payouts/${id}/approve`, { method: 'POST' });
    load();
  }
  async function reject(id: string) {
    const reason = prompt('Motivo da rejeicao:');
    if (!reason) return;
    await adminFetch(`/sellers/admin/payouts/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });
    load();
  }
  async function processTransfer(id: string) {
    if (!confirm('Processar transferencia Asaas agora?')) return;
    await adminFetch(`/payments/payouts/${id}/process`, { method: 'POST' });
    load();
  }

  return (
    <div>
      <h1 className="font-display font-bold text-4xl mb-2">Saques</h1>
      <p className="text-white/60 mb-8">Solicitacoes de payout aguardando aprovacao</p>

      {error && <div className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg mb-4">{error}</div>}

      <div className="glass p-6">
        {list.length === 0 ? (
          <p className="text-white/60 text-center py-8">Nenhum saque pendente.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-white/40 uppercase border-b border-white/10">
              <tr><th className="py-2">Seller</th><th>Valor</th><th>Solicitado</th><th>Status</th><th className="text-right">Acoes</th></tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id} className="border-b border-white/5 hover:bg-white/5">
                  <td className="py-3">{p.store_name}</td>
                  <td className="font-display font-bold text-magenta-glow">{fmtBRL(p.amount_cents)}</td>
                  <td className="text-xs text-white/50">{fmtDate(p.requested_at)}</td>
                  <td><span className="px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-400 text-xs">{p.status}</span></td>
                  <td className="text-right space-x-2">
                    {p.status === 'pending' && (
                      <>
                        <button onClick={() => approve(p.id)} className="text-green-400 hover:underline text-xs inline-flex items-center gap-1">
                          <Check className="w-3 h-3" /> Aprovar
                        </button>
                        <button onClick={() => reject(p.id)} className="text-red-400 hover:underline text-xs inline-flex items-center gap-1">
                          <X className="w-3 h-3" /> Rejeitar
                        </button>
                      </>
                    )}
                    {p.status === 'approved' && (
                      <button onClick={() => processTransfer(p.id)} className="text-magenta hover:underline text-xs inline-flex items-center gap-1">
                        <Send className="w-3 h-3" /> Transferir Asaas
                      </button>
                    )}
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
