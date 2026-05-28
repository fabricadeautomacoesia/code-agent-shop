'use client';

import { useEffect, useState } from 'react';
import { adminFetch, fmtDate } from '@/lib/admin-api';
import { useAdminAction } from '@/lib/use-admin-action';
import { Ban, CheckCircle, ArrowUp, ShieldCheck } from 'lucide-react';

export default function SellersPage() {
  const [pending, setPending] = useState<any[]>([]);
  const [loadError, setLoadError] = useState('');
  // FIX-WORKER-4 pass 414 (search filter scale - 100+ KYC pending):
  //   Backend pass 414 adicionou ?q search em /pending-kyc
  //   Frontend: input debounced 300ms + load() trigger
  const [searchQuery, setSearchQuery] = useState('');

  async function load(q?: string) {
    try {
      const qs = q !== undefined ? `?q=${encodeURIComponent(q)}` : '';
      const r = await adminFetch<{ sellers: any[] }>(`/sellers/admin/pending-kyc${qs}`);
      setPending(r.sellers);
      setLoadError('');
    }
    catch (e: any) { setLoadError(e.message); }
  }
  useEffect(() => { load(); }, []);

  // Debounced search trigger
  useEffect(() => {
    const t = setTimeout(() => { load(searchQuery.trim()); }, 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // FIX-WORKER-4 pass 2: useAdminAction hook
  const action = useAdminAction(load);

  async function suspend(id: string) {
    // FIX-WORKER-4 pass 149: PromptDialog acessivel + estilizado
    const { promptDialog } = await import('@/components/prompt-dialog');
    const reason = await promptDialog('Motivo da suspensao:', 'Ex: violacao termos de uso');
    if (!reason) return;
    action.run(`suspend-${id}`, async () => {
      await adminFetch(`/sellers/admin/${id}/suspend`, { method: 'POST', body: JSON.stringify({ reason }) });
      return `Seller ${id.slice(0, 8)}... suspenso`;
    });
  }
  async function promoteB(id: string) {
    const { confirmDialog } = await import('@/components/prompt-dialog');
    if (!await confirmDialog('Promover este seller para Classe B?', { body: 'Acesso ao programa Cloud Code Ilimitado.' })) return;
    action.run(`promote-${id}`, async () => {
      await adminFetch(`/sellers/admin/${id}/promote-class-b`, { method: 'POST', body: JSON.stringify({ sla_days: 15 }) });
      return `Seller ${id.slice(0, 8)}... promovido para Classe B`;
    });
  }

  // FIX-WORKER-4 pass 370 (endpoint /kyc/approve NAO TINHA UI):
  //   PRE-FIX: backend /sellers/admin/:id/kyc/approve (pass 42) existia
  //   mas frontend dashboard-admin nao tinha botao p/ acionar.
  //   Admin precisava acessar via curl manual ou Postman.
  //   Apenas "Suspender" e "Classe B" disponiveis - aprovacao KYC ficou inacessivel.
  //   Resultado: admin nao conseguia aprovar KYC de sellers rejeitados.
  //   POST-FIX: + funcao approveKyc + botao verde com ShieldCheck icon.
  async function approveKyc(id: string) {
    const { confirmDialog } = await import('@/components/prompt-dialog');
    if (!await confirmDialog('Aprovar KYC deste seller?', { body: 'Seller podera operar normalmente (publicar produtos, receber payouts).' })) return;
    action.run(`approve-${id}`, async () => {
      await adminFetch(`/sellers/admin/${id}/kyc/approve`, { method: 'POST' });
      return `KYC do seller ${id.slice(0, 8)}... aprovado`;
    });
  }

  return (
    <div>
      <h1 className="font-display font-bold text-4xl mb-2">Sellers</h1>
      <p className="text-white/60 mb-8">Gestao de vendedores e KYC pendente</p>

      {/* FIX-WORKER-4 pass 427 (a11y parity cross-admin paridade payouts): role=alert + retry */}
      {loadError && (
        <div role="alert" className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg mb-4 flex items-center justify-between">
          <span>Erro carregando lista: {loadError}</span>
          <button type="button" onClick={() => { setLoadError(''); load(); }}
            aria-label="Tentar carregar sellers novamente"
            className="text-xs hover:underline focus-visible:outline-2 focus-visible:outline-red-400 rounded">retry</button>
        </div>
      )}

      {/* FIX-WORKER-4 pass 2 + 171 (a11y V8 R23): role=alert/status + type=button + aria-label */}
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
        <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
          <h2 className="font-display font-bold text-xl">KYC Pendente ({pending.length})</h2>
          {/* FIX-WORKER-4 pass 414: search input p/ scale 100+ sellers KYC */}
          <input type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Buscar nome/email/legal_name..."
            maxLength={100}
            aria-label="Filtrar sellers KYC pendente"
            className="px-3 py-1.5 text-xs rounded bg-white/5 border border-white/10 focus:border-magenta focus:outline-none w-60" />
        </div>
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
                    {/* FIX-WORKER-4 pass 171 (a11y V8 R23): type=button + aria-label */}
                    {/* FIX-WORKER-4 pass 370: + Aprovar KYC button (endpoint pre-existing pass 42) */}
                    <button type="button" onClick={() => approveKyc(s.id)} disabled={action.busyKey === `approve-${s.id}`}
                      aria-label={`Aprovar KYC do seller ${s.store_name}`}
                      className="text-green-400 hover:underline text-xs inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-wait focus-visible:outline-2 focus-visible:outline-green-400 rounded">
                      <ShieldCheck className="w-3 h-3" aria-hidden="true" /> {action.busyKey === `approve-${s.id}` ? '...' : 'Aprovar KYC'}
                    </button>
                    {s.seller_class === 'class_a' && (
                      <button type="button" onClick={() => promoteB(s.id)} disabled={action.busyKey === `promote-${s.id}`}
                        aria-label={`Promover ${s.store_name} para classe B (KYC completo)`}
                        className="text-magenta hover:underline text-xs inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-wait focus-visible:outline-2 focus-visible:outline-magenta rounded">
                        <ArrowUp className="w-3 h-3" aria-hidden="true" /> {action.busyKey === `promote-${s.id}` ? '...' : 'Classe B'}
                      </button>
                    )}
                    <button type="button" onClick={() => suspend(s.id)} disabled={action.busyKey === `suspend-${s.id}`}
                      aria-label={`Suspender seller ${s.store_name}`}
                      className="text-red-400 hover:underline text-xs inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-wait focus-visible:outline-2 focus-visible:outline-red-400 rounded">
                      <Ban className="w-3 h-3" aria-hidden="true" /> {action.busyKey === `suspend-${s.id}` ? '...' : 'Suspender'}
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
