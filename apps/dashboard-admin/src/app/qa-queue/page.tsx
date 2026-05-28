'use client';

import { useEffect, useState } from 'react';
import { adminFetch, fmtDate } from '@/lib/admin-api';
import { useAdminAction } from '@/lib/use-admin-action';
import { CheckCircle, XCircle, Award } from 'lucide-react';

export default function QAQueuePage() {
  const [queue, setQueue] = useState<any[]>([]);
  // FIX-WORKER-4 pass 5: loadError visivel ao admin.
  // Antes: console.error silencioso + tabela "Fila vazia" enganosa quando havia
  // erro real (backend down, token expirado, etc). Admin pensava sistema saudavel.
  const [loadError, setLoadError] = useState('');

  async function load() {
    try {
      const r = await adminFetch<{ queue: any[] }>('/products/admin/qa-queue');
      // FIX-WORKER-4 pass 5: guard contra r.queue null/undefined (edge case backend)
      setQueue(r.queue || []);
      setLoadError('');
    } catch (e: any) {
      console.error(e);
      setLoadError(e?.message || 'Erro carregando fila QA');
      setQueue([]); // limpa lista para nao mostrar dados stale
    }
  }
  useEffect(() => { load(); }, []);

  // FIX-WORKER-4 pass 2: useAdminAction hook substitui try/catch repetido
  const action = useAdminAction(load);

  async function forceApprove(id: string) {
    const reason = prompt('Justificativa para aprovacao manual (override LLM):');
    if (!reason) return;
    action.run(`approve-${id}`, async () => {
      await adminFetch(`/products/admin/${id}/force-approve`, { method: 'POST', body: JSON.stringify({ reason }) });
      return `Produto ${id.slice(0, 8)}... aprovado manualmente`;
    });
  }
  async function platformTake(id: string) {
    const { confirmDialog, promptDialog } = await import('@/components/prompt-dialog');
    if (!await confirmDialog('Acionar Clausula Master de Revenda Direta?', {
      body: 'Isso cria copia do produto como is_platform_owned=TRUE (100% lucro plataforma).',
      variant: 'danger', confirmLabel: 'Acionar Clausula',
    })) return;
    const reason = await promptDialog('Justificativa:', 'Ex: produto abandonado pelo vendedor');
    if (!reason) return;
    action.run(`take-${id}`, async () => {
      await adminFetch(`/products/admin/${id}/platform-take`, { method: 'POST', body: JSON.stringify({ reason }) });
      return `Platform-take ${id.slice(0, 8)}... criado`;
    });
  }

  const statusColor: Record<string, string> = {
    qa_pending:  'bg-yellow-500/20 text-yellow-400',
    qa_running:  'bg-blue-500/20 text-blue-400',
    rejected:    'bg-red-500/20 text-red-400',
    approved:    'bg-green-500/20 text-green-400',
  };

  return (
    <div>
      <h1 className="font-display font-bold text-4xl mb-2">QA Queue</h1>
      <p className="text-white/60 mb-4">Produtos aguardando ou rejeitados pelo pipeline LLM (threshold 0.80)</p>

      {/* FIX-WORKER-4 pass 14: alert banner se ha produtos com timeout recente
          (W12 pass 7 cron cancela runs stuck >10min - indica n8n/worker issue infra) */}
      {(() => {
        const timeoutCount = queue.filter((p) => p.last_run_verdict === 'timeout').length;
        if (timeoutCount === 0) return null;
        return (
          <div className="bg-orange-500/10 border-l-4 border-orange-500 text-orange-200 p-4 rounded-lg mb-4">
            <div className="font-semibold mb-1 text-sm">
              {timeoutCount} produto(s) com QA timeout recente
            </div>
            <div className="text-xs opacity-80">
              QA pipeline cancelou automaticamente runs travados {'>'} 10min (W12 cron).
              Possivel causa: n8n down, worker.py crash, callback HTTP fail.
              Verifique infra antes de force-approve.
            </div>
          </div>
        );
      })()}
      <div className="mb-4" />


      {/* FIX-WORKER-4 pass 5: loadError banner. Antes silencioso em console
          + "Fila vazia" enganosa. Agora admin ve falhas explicitas. */}
      {loadError && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg mb-4 flex items-center justify-between">
          <span>Erro carregando fila: {loadError}</span>
          <button onClick={() => { setLoadError(''); load(); }} className="text-xs hover:underline">retry</button>
        </div>
      )}

      {/* FIX-WORKER-4 pass 2: feedback banners via useAdminAction */}
      {action.error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg mb-4 flex items-center justify-between">
          <span>{action.error}</span>
          <button onClick={action.clear} className="text-xs hover:underline">fechar</button>
        </div>
      )}
      {action.success && (
        <div className="bg-green-500/10 border border-green-500/30 text-green-400 p-4 rounded-lg mb-4 flex items-center justify-between">
          <span>{action.success}</span>
          <button onClick={action.clear} className="text-xs hover:underline">fechar</button>
        </div>
      )}

      <div className="glass p-6 overflow-x-auto">
        {queue.length === 0 ? (
          /* FIX-WORKER-4 pass 5: msg condicional baseada em loadError state.
             Se erro -> mensagem ja exibida acima. Se sem erro -> realmente vazia. */
          <p className="text-white/60 text-center py-8">
            {loadError ? 'Nao foi possivel carregar a fila. Tente o retry acima.' : 'Fila vazia. Sistema saudavel.'}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-white/40 uppercase border-b border-white/10">
              <tr>
                <th className="py-2">Titulo</th><th>Vendedor</th><th>Status</th>
                {/* FIX-WORKER-4 pass 14: nova coluna "Ultima tentativa" (W12 pass 7 timeouts) */}
                <th>Ultima tentativa</th>
                <th>QA Score</th><th>Enviado</th><th className="text-right">Acoes</th>
              </tr>
            </thead>
            <tbody>
              {queue.map((p) => {
                // FIX-WORKER-4 pass 5: acoes condicionais ao status.
                // - force-approve: so faz sentido se nao aprovado ainda
                //   (approved -> noop / qa_running -> race condition)
                // - platform-take: NAO em produtos ja platform-owned (loop)
                //   nem em qa_running (estado transitorio)
                const canApprove = ['qa_pending','rejected'].includes(p.status);
                const canTake = ['qa_pending','rejected','approved'].includes(p.status) && !p.is_platform_owned;
                return (
                <tr key={p.id} className="border-b border-white/5 hover:bg-white/5">
                  <td className="py-3">
                    <div className="font-medium">{p.title}</div>
                    <div className="text-xs text-white/40 font-mono">{p.slug}</div>
                  </td>
                  {/* FIX-WORKER-4 pass 5: produtos da plataforma exibem badge "Plataforma CAS"
                      em vez de "-" enganoso (era ambiguo: faltou seller? bug? oficial?) */}
                  <td className="text-white/70">
                    {p.is_platform_owned ? (
                      <span className="inline-flex items-center gap-1 text-magenta-glow text-xs">
                        <Award className="w-3 h-3" /> Plataforma CAS
                      </span>
                    ) : (p.store_name || '-')}
                  </td>
                  <td><span className={`px-2 py-0.5 rounded text-xs ${statusColor[p.status]}`}>{p.status}</span></td>
                  {/* FIX-WORKER-4 pass 14: ultima tentativa verdict (timeout warning principal) */}
                  <td>
                    {p.last_run_verdict ? (
                      <div className="flex flex-col gap-0.5">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase font-bold w-fit ${
                          p.last_run_verdict === 'timeout'  ? 'bg-orange-500/20 text-orange-300' :
                          p.last_run_verdict === 'error'    ? 'bg-red-500/20 text-red-300' :
                          p.last_run_verdict === 'rejected' ? 'bg-red-500/20 text-red-400' :
                          p.last_run_verdict === 'approved' ? 'bg-green-500/20 text-green-400' :
                          p.last_run_verdict === 'running'  ? 'bg-blue-500/20 text-blue-300' :
                                                              'bg-white/10 text-white/40'
                        }`}>
                          {p.last_run_verdict}
                        </span>
                        {p.timeout_count > 0 && (
                          <span className="text-[10px] text-orange-300/80" title={`${p.timeout_count} timeout(s) historicos`}>
                            x{p.timeout_count} timeout(s)
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-[10px] text-white/30">sem runs</span>
                    )}
                  </td>
                  <td>
                    {p.qa_confidence_score !== null && (
                      <span className={`font-mono text-xs ${p.qa_confidence_score >= 0.8 ? 'text-green-400' : 'text-red-400'}`}>
                        {(p.qa_confidence_score * 100).toFixed(1)}%
                      </span>
                    )}
                  </td>
                  <td className="text-xs text-white/50">{p.submitted_at ? fmtDate(p.submitted_at) : '-'}</td>
                  <td className="text-right space-x-2">
                    {canApprove && (
                      <button onClick={() => forceApprove(p.id)} disabled={action.busyKey === `approve-${p.id}`}
                        className="text-green-400 hover:underline text-xs inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-wait">
                        <CheckCircle className="w-3 h-3" /> {action.busyKey === `approve-${p.id}` ? '...' : 'Aprovar'}
                      </button>
                    )}
                    {canTake && (
                      <button onClick={() => platformTake(p.id)} disabled={action.busyKey === `take-${p.id}`}
                        className="text-magenta hover:underline text-xs inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-wait">
                        <Award className="w-3 h-3" /> {action.busyKey === `take-${p.id}` ? '...' : 'Take'}
                      </button>
                    )}
                    {!canApprove && !canTake && (
                      <span className="text-white/30 text-xs italic">sem acoes</span>
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
