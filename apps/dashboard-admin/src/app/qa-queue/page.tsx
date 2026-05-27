'use client';

import { useEffect, useState } from 'react';
import { adminFetch, fmtDate } from '@/lib/admin-api';
import { useAdminAction } from '@/lib/use-admin-action';
import { CheckCircle, XCircle, Award } from 'lucide-react';

export default function QAQueuePage() {
  const [queue, setQueue] = useState<any[]>([]);

  async function load() {
    try { const r = await adminFetch<{ queue: any[] }>('/products/admin/qa-queue'); setQueue(r.queue); }
    catch (e: any) { console.error(e); }
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
    if (!confirm('Acionar Clausula Master de Revenda Direta?\nIsso cria copia do produto como is_platform_owned=TRUE (100% lucro plataforma).')) return;
    const reason = prompt('Justificativa:');
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
      <p className="text-white/60 mb-8">Produtos aguardando ou rejeitados pelo pipeline LLM (threshold 0.80)</p>

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
          <p className="text-white/60 text-center py-8">Fila vazia. Sistema saudavel.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-white/40 uppercase border-b border-white/10">
              <tr>
                <th className="py-2">Titulo</th><th>Vendedor</th><th>Status</th><th>QA Score</th><th>Enviado</th><th className="text-right">Acoes</th>
              </tr>
            </thead>
            <tbody>
              {queue.map((p) => (
                <tr key={p.id} className="border-b border-white/5 hover:bg-white/5">
                  <td className="py-3">
                    <div className="font-medium">{p.title}</div>
                    <div className="text-xs text-white/40 font-mono">{p.slug}</div>
                  </td>
                  <td className="text-white/70">{p.store_name || '-'}</td>
                  <td><span className={`px-2 py-0.5 rounded text-xs ${statusColor[p.status]}`}>{p.status}</span></td>
                  <td>
                    {p.qa_confidence_score !== null && (
                      <span className={`font-mono text-xs ${p.qa_confidence_score >= 0.8 ? 'text-green-400' : 'text-red-400'}`}>
                        {(p.qa_confidence_score * 100).toFixed(1)}%
                      </span>
                    )}
                  </td>
                  <td className="text-xs text-white/50">{p.submitted_at ? fmtDate(p.submitted_at) : '-'}</td>
                  <td className="text-right space-x-2">
                    <button onClick={() => forceApprove(p.id)} disabled={action.busyKey === `approve-${p.id}`}
                      className="text-green-400 hover:underline text-xs inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-wait">
                      <CheckCircle className="w-3 h-3" /> {action.busyKey === `approve-${p.id}` ? '...' : 'Aprovar'}
                    </button>
                    <button onClick={() => platformTake(p.id)} disabled={action.busyKey === `take-${p.id}`}
                      className="text-magenta hover:underline text-xs inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-wait">
                      <Award className="w-3 h-3" /> {action.busyKey === `take-${p.id}` ? '...' : 'Take'}
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
