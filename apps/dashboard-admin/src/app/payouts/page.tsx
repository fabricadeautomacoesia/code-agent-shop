'use client';

import { useEffect, useState } from 'react';
import { adminFetch, fmtBRL, fmtDate } from '@/lib/admin-api';
import { Check, X, Send } from 'lucide-react';

export default function PayoutsPage() {
  const [list, setList] = useState<any[]>([]);
  const [error, setError] = useState('');
  // FIX-WORKER-4 pass 1: success toast UX + busy state evita double-click
  const [success, setSuccess] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    try { const r = await adminFetch<{ payouts: any[] }>('/sellers/admin/payouts/pending'); setList(r.payouts); }
    catch (e: any) { setError(e.message); }
  }
  useEffect(() => { load(); }, []);

  // FIX-WORKER-4 pass 1: try/catch + clear feedback (era silent swallow).
  // Antes: user clicava aprovar -> request falhava silenciosamente -> "travou".
  // Agora: loading state + error/success toast + auto-clear.
  async function approve(id: string) {
    setError(''); setSuccess(''); setBusyId(id);
    try {
      await adminFetch(`/sellers/admin/payouts/${id}/approve`, { method: 'POST' });
      setSuccess(`Payout ${id.slice(0, 8)}... aprovado`);
      await load();
    } catch (e: any) {
      setError(`Falha ao aprovar: ${e.message || 'erro desconhecido'}`);
    } finally { setBusyId(null); }
  }
  async function reject(id: string) {
    const reason = prompt('Motivo da rejeicao:');
    if (!reason) return;
    setError(''); setSuccess(''); setBusyId(id);
    try {
      await adminFetch(`/sellers/admin/payouts/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });
      setSuccess(`Payout ${id.slice(0, 8)}... rejeitado`);
      await load();
    } catch (e: any) {
      setError(`Falha ao rejeitar: ${e.message || 'erro desconhecido'}`);
    } finally { setBusyId(null); }
  }
  async function processTransfer(id: string) {
    if (!confirm('Processar transferencia Asaas agora?')) return;
    setError(''); setSuccess(''); setBusyId(id);
    try {
      await adminFetch(`/payments/payouts/${id}/process`, { method: 'POST' });
      setSuccess(`Transferencia ${id.slice(0, 8)}... enviada para Asaas`);
      await load();
    } catch (e: any) {
      setError(`Falha ao processar transferencia: ${e.message || 'erro desconhecido'}`);
    } finally { setBusyId(null); }
  }

  return (
    <div>
      <h1 className="font-display font-bold text-4xl mb-2">Saques</h1>
      <p className="text-white/60 mb-8">Solicitacoes de payout aguardando aprovacao</p>

      {/* FIX-WORKER-4 pass 1: feedback dual (success verde + erro vermelho) */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg mb-4 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError('')} className="text-xs hover:underline">fechar</button>
        </div>
      )}
      {success && (
        <div className="bg-green-500/10 border border-green-500/30 text-green-400 p-4 rounded-lg mb-4 flex items-center justify-between">
          <span>{success}</span>
          <button onClick={() => setSuccess('')} className="text-xs hover:underline">fechar</button>
        </div>
      )}

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
                        <button onClick={() => approve(p.id)} disabled={busyId === p.id}
                          className="text-green-400 hover:underline text-xs inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-wait">
                          <Check className="w-3 h-3" /> {busyId === p.id ? '...' : 'Aprovar'}
                        </button>
                        <button onClick={() => reject(p.id)} disabled={busyId === p.id}
                          className="text-red-400 hover:underline text-xs inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-wait">
                          <X className="w-3 h-3" /> Rejeitar
                        </button>
                      </>
                    )}
                    {p.status === 'approved' && (
                      <button onClick={() => processTransfer(p.id)} disabled={busyId === p.id}
                        className="text-magenta hover:underline text-xs inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-wait">
                        <Send className="w-3 h-3" /> {busyId === p.id ? 'Enviando...' : 'Transferir Asaas'}
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
