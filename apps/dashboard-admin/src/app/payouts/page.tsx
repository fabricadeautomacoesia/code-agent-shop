'use client';

import { useEffect, useState } from 'react';
import { adminFetch, fmtBRL, fmtDate } from '@/lib/admin-api';
import { useAdminAction } from '@/lib/use-admin-action';
import { Check, X, Send } from 'lucide-react';

export default function PayoutsPage() {
  const [list, setList] = useState<any[]>([]);
  const [loadError, setLoadError] = useState('');
  // FIX-WORKER-4 pass 4: filtro de status. Antes UI so via 'pending', nunca
  // mostrava botao "Transferir Asaas" (que dependia de status='approved').
  // Default 'all' garante que admin ve TODO o pipeline (pending+approved).
  // FIX-WORKER-4 pass 356: + paid + rejected + all_states
  //   Auditoria financeira / forense precisa ver payouts pagos+rejeitados.
  //   Antes admin tinha que query DB direto (slow + sem cache).
  //   Backend agora suporta 6 valores - UI expoe 5 (all_states substitui exclusive view).
  const [statusFilter, setStatusFilter] = useState<'pending'|'approved'|'paid'|'rejected'|'all_states'>('pending');

  async function load() {
    try {
      const r = await adminFetch<{ payouts: any[] }>(`/sellers/admin/payouts/pending?status=${statusFilter}`);
      setList(r.payouts); setLoadError('');
    }
    catch (e: any) { setLoadError(e.message); }
  }
  useEffect(() => { load(); }, [statusFilter]);

  // FIX-WORKER-4 pass 3: refactor para usar useAdminAction hook (W4 pass 2).
  // Antes inline try/catch + 3 states (busyId, error, success) duplicados ~30 linhas.
  // Agora: 1 linha hook + cleanup. Pattern consistente com qa-queue + sellers.
  const action = useAdminAction(load);

  async function approve(id: string) {
    action.run(`approve-${id}`, async () => {
      await adminFetch(`/sellers/admin/payouts/${id}/approve`, { method: 'POST' });
      return `Payout ${id.slice(0, 8)}... aprovado`;
    });
  }
  async function reject(id: string) {
    // FIX-WORKER-4 pass 149: PromptDialog acessivel + estilizado
    const { promptDialog } = await import('@/components/prompt-dialog');
    const reason = await promptDialog('Motivo da rejeicao:', 'Ex: dados bancarios invalidos');
    if (!reason) return;
    action.run(`reject-${id}`, async () => {
      await adminFetch(`/sellers/admin/payouts/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });
      return `Payout ${id.slice(0, 8)}... rejeitado`;
    });
  }
  async function processTransfer(id: string) {
    const { confirmDialog } = await import('@/components/prompt-dialog');
    if (!await confirmDialog('Processar transferencia Asaas agora?')) return;
    action.run(`transfer-${id}`, async () => {
      await adminFetch(`/payments/payouts/${id}/process`, { method: 'POST' });
      return `Transferencia ${id.slice(0, 8)}... enviada para Asaas`;
    });
  }

  return (
    <div>
      <h1 className="font-display font-bold text-4xl mb-2">Saques</h1>
      <p className="text-white/60 mb-6">Pipeline de payouts: pending -&gt; approved -&gt; transferido Asaas</p>

      {/* FIX-WORKER-4 pass 4: filtro 3-vias permite ver approved payouts e disparar transferir
          FIX-WORKER-4 pass 155 (a11y): role=radiogroup + role=radio + aria-checked
          + aria-labelledby p/ SR anunciar grupo semantico */}
      <h2 id="payouts-filter-label" className="sr-only">Filtrar payouts por status</h2>
      {/* FIX-WORKER-4 pass 356: + paid + rejected + all_states filtros
          Pipeline completo agora visivel admin: pending->approved->paid|rejected.
          Auditoria forense via all_states. Labels PT-BR explicitos. */}
      <div role="radiogroup" aria-labelledby="payouts-filter-label" className="flex gap-2 mb-6 flex-wrap">
        {([
          { v: 'pending',    l: 'Pendentes' },
          { v: 'approved',   l: 'Aprovados' },
          { v: 'paid',       l: 'Pagos' },
          { v: 'rejected',   l: 'Rejeitados' },
          { v: 'all_states', l: 'Todos (auditoria)' },
        ] as const).map((s) => (
          <button key={s.v} type="button" onClick={() => setStatusFilter(s.v)}
            role="radio" aria-checked={statusFilter === s.v}
            className={`px-3 py-1.5 rounded-lg text-xs uppercase font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-magenta ${
              statusFilter === s.v ? 'bg-gradient-to-r from-magenta to-violet-deep text-white' : 'glass hover:border-white/30'
            }`}>
            {s.l}
          </button>
        ))}
      </div>

      {/* FIX-WORKER-4 pass 427 (a11y parity cross-admin):
          PRE-FIX: loadError banner SEM role=alert (SR nao anunciava falha)
          - qa-queue pass 5 ja tinha role=alert + retry
          - orders pass 171 tambem
          - financeiro seller pass 240 + qna pass 248 + loja pass 263 (paridade)
          - admin/payouts ficou para tras (SR nao escutava falhas de pipeline payouts)
          POST-FIX: role=alert + retry button (paridade qa-queue + orders) */}
      {loadError && (
        <div role="alert" className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg mb-4 flex items-center justify-between">
          <span>Erro carregando lista: {loadError}</span>
          <button type="button" onClick={() => { setLoadError(''); load(); }}
            aria-label="Tentar carregar payouts novamente"
            className="text-xs hover:underline focus-visible:outline-2 focus-visible:outline-red-400 rounded">retry</button>
        </div>
      )}

      {/* FIX-WORKER-4 pass 3: banners via useAdminAction (DRY com qa-queue + sellers) */}
      {action.error && (
        <div role="alert" className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg mb-4 flex items-center justify-between">
          <span>{action.error}</span>
          <button type="button" onClick={action.clear} aria-label="Fechar mensagem de erro"
            className="text-xs hover:underline focus-visible:outline-2 focus-visible:outline-red-400 rounded">fechar</button>
        </div>
      )}
      {action.success && (
        <div role="status" aria-live="polite" className="bg-green-500/10 border border-green-500/30 text-green-400 p-4 rounded-lg mb-4 flex items-center justify-between">
          <span>{action.success}</span>
          <button type="button" onClick={action.clear} aria-label="Fechar mensagem de sucesso"
            className="text-xs hover:underline focus-visible:outline-2 focus-visible:outline-green-400 rounded">fechar</button>
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
              {list.map((p) => {
                const busyApprove = action.busyKey === `approve-${p.id}`;
                const busyReject = action.busyKey === `reject-${p.id}`;
                const busyTransfer = action.busyKey === `transfer-${p.id}`;
                return (
                  <tr key={p.id} className="border-b border-white/5 hover:bg-white/5">
                    <td className="py-3">{p.store_name}</td>
                    <td className="font-display font-bold text-magenta-glow">{fmtBRL(p.amount_cents)}</td>
                    <td className="text-xs text-white/50">{fmtDate(p.requested_at)}</td>
                    {/* FIX-WORKER-4 pass 4: badge cor por status (era sempre amarelo pending) */}
                    <td><span className={`px-2 py-0.5 rounded text-xs ${
                      p.status === 'pending'  ? 'bg-yellow-500/20 text-yellow-400' :
                      p.status === 'approved' ? 'bg-blue-500/20 text-blue-400' :
                      p.status === 'paid'     ? 'bg-green-500/20 text-green-400' :
                      p.status === 'rejected' ? 'bg-red-500/20 text-red-400' :
                      'bg-white/10 text-white/40'
                    }`}>{p.status}</span></td>
                    <td className="text-right space-x-2">
                      {p.status === 'pending' && (
                        <>
                          {/* FIX-WORKER-4 pass 170 (a11y V8 R23): type=button + aria-label dinamico */}
                          <button type="button" onClick={() => approve(p.id)} disabled={busyApprove || busyReject}
                            aria-label={`Aprovar payout de ${p.store_name} no valor de ${fmtBRL(p.amount_cents)}`}
                            className="text-green-400 hover:underline text-xs inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-wait focus-visible:outline-2 focus-visible:outline-green-400 rounded">
                            <Check className="w-3 h-3" aria-hidden="true" /> {busyApprove ? '...' : 'Aprovar'}
                          </button>
                          <button type="button" onClick={() => reject(p.id)} disabled={busyApprove || busyReject}
                            aria-label={`Rejeitar payout de ${p.store_name} no valor de ${fmtBRL(p.amount_cents)}`}
                            className="text-red-400 hover:underline text-xs inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-wait focus-visible:outline-2 focus-visible:outline-red-400 rounded">
                            <X className="w-3 h-3" aria-hidden="true" /> {busyReject ? '...' : 'Rejeitar'}
                          </button>
                        </>
                      )}
                      {p.status === 'approved' && (
                        <button type="button" onClick={() => processTransfer(p.id)} disabled={busyTransfer}
                          aria-label={`Processar transferencia Asaas de ${p.store_name}, valor ${fmtBRL(p.amount_cents)}`}
                          className="text-magenta hover:underline text-xs inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-wait focus-visible:outline-2 focus-visible:outline-magenta rounded">
                          <Send className="w-3 h-3" aria-hidden="true" /> {busyTransfer ? 'Enviando...' : 'Transferir Asaas'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
