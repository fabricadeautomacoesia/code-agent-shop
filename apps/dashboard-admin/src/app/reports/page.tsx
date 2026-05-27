'use client';

import { useEffect, useState } from 'react';
import { adminFetch, fmtDate } from '@/lib/admin-api';
import { useAdminAction } from '@/lib/use-admin-action';
import { AlertOctagon, Check, X } from 'lucide-react';

const REASON_LABEL: Record<string, string> = {
  plagiarism: 'Plagio',
  spam:       'Spam',
  scam:       'Fraude',
  offensive:  'Ofensivo',
  copyright:  'Direitos autorais',
  other:      'Outro',
};

export default function AdminReportsPage() {
  const [reports, setReports] = useState<any[]>([]);
  const [filter, setFilter] = useState('open');
  const [loadError, setLoadError] = useState('');

  async function load() {
    try {
      const r = await adminFetch<{ reports: any[] }>(`/reviews/admin/reports?status=${filter}`);
      setReports(r.reports || []);
      setLoadError('');
    } catch (e: any) {
      setLoadError(e.message);
    }
  }
  useEffect(() => { load(); }, [filter]);

  // FIX-WORKER-4 pass 5: useAdminAction hook (W4 pass 2 pattern).
  // Antes: resolve() era silent swallow em error (await sem try/catch).
  // Agora: feedback explicit success/error + busyKey per-row.
  const action = useAdminAction(load);

  async function resolve(id: string, dismissed = false) {
    const notes = prompt(dismissed ? 'Justificativa para descartar:' : 'Notas da resolucao:');
    if (!notes) return;
    const op = dismissed ? 'dismiss' : 'resolve';
    action.run(`${op}-${id}`, async () => {
      await adminFetch(`/reviews/reports/${id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ status: dismissed ? 'dismissed' : 'resolved', notes }),
      });
      return `Denuncia ${id.slice(0, 8)}... ${dismissed ? 'descartada' : 'resolvida'}`;
    });
  }

  return (
    <div>
      <div className="flex items-end justify-between mb-8">
        <div>
          <h1 className="font-display font-bold text-4xl mb-2">Denuncias</h1>
          <p className="text-white/60">Moderacao de produtos, sellers, reviews e Q&A</p>
        </div>
        <select value={filter} onChange={(e) => setFilter(e.target.value)}
          className="glass px-4 py-2 text-sm bg-transparent text-white">
          <option value="open">Abertos</option>
          <option value="under_review">Em analise</option>
          <option value="resolved">Resolvidos</option>
          <option value="dismissed">Descartados</option>
        </select>
      </div>

      {/* FIX-WORKER-4 pass 7: loadError com retry (consistente W4 pass 6 /admin/orders) */}
      {loadError && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg mb-4 flex items-center justify-between">
          <span>Erro carregando lista: {loadError}</span>
          <button onClick={() => { setLoadError(''); load(); }} className="text-xs hover:underline">retry</button>
        </div>
      )}

      {/* FIX-WORKER-4 pass 5: banners action via useAdminAction */}
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

      <div className="glass p-6">
        {reports.length === 0 ? (
          /* FIX-WORKER-4 pass 7: msg condicional por filter (era generica "Sistema limpo"
             mesmo em filter resolved que sugeria problema) */
          <p className="text-white/60 text-center py-12 flex items-center justify-center gap-2">
            <AlertOctagon className="w-5 h-5 text-green-400" aria-hidden="true" />
            {filter === 'open' && 'Nenhuma denuncia aberta. Sistema limpo.'}
            {filter === 'under_review' && 'Nenhuma denuncia em analise no momento.'}
            {filter === 'resolved' && 'Nenhuma denuncia resolvida com esse filtro.'}
            {filter === 'dismissed' && 'Nenhuma denuncia descartada.'}
          </p>
        ) : (
          <div className="space-y-3">
            {reports.map((r) => {
              // FIX-WORKER-4 pass 7: borda colorida por status (era fixa yellow)
              const borderColor =
                r.status === 'resolved'      ? 'border-green-500' :
                r.status === 'dismissed'     ? 'border-white/30' :
                r.status === 'under_review'  ? 'border-blue-500' :
                                               'border-yellow-500';
              // FIX-WORKER-4 pass 7: target link funcional (admin clica e vai pro item)
              const targetLink =
                r.target_type === 'product' ? `https://cas.inovareinteligenciaartificial.com/product/${r.target_slug || r.target_id}` :
                r.target_type === 'seller'  ? `https://cas.inovareinteligenciaartificial.com/seller/${r.target_slug || r.target_id}` :
                null;
              return (
              <div key={r.id} className={`border-l-4 ${borderColor} p-4 bg-white/5 rounded`}>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-2 flex-wrap">
                      <span className="px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-400 text-xs uppercase">
                        {REASON_LABEL[r.reason_code] || r.reason_code}
                      </span>
                      {/* FIX-WORKER-4 pass 7: target_id agora linkado se aplicavel */}
                      {targetLink ? (
                        <a href={targetLink} target="_blank" rel="noopener noreferrer"
                          className="text-xs text-magenta hover:underline font-mono">
                          {r.target_type}#{r.target_id?.slice(0, 8)} &rarr;
                        </a>
                      ) : (
                        <span className="text-xs text-white/40 font-mono">{r.target_type}#{r.target_id?.slice(0, 8)}</span>
                      )}
                      <span className="text-xs text-white/40">{fmtDate(r.created_at)}</span>
                      {/* FIX-WORKER-4 pass 7: status badge p/ non-open reports */}
                      {r.status !== 'open' && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded uppercase font-bold ${
                          r.status === 'resolved'  ? 'bg-green-500/20 text-green-400' :
                          r.status === 'dismissed' ? 'bg-white/10 text-white/50' :
                                                     'bg-blue-500/20 text-blue-400'
                        }`}>{r.status}</span>
                      )}
                    </div>
                    {r.description && <p className="text-sm text-white/80 mb-2 break-words">{r.description}</p>}
                    {/* FIX-WORKER-4 pass 7: evidencias numeradas + rel security */}
                    {r.evidence_urls?.length > 0 && (
                      <div className="text-xs text-white/50 flex flex-wrap items-center gap-1.5">
                        <span>Evidencias:</span>
                        {r.evidence_urls.map((u: string, idx: number) => (
                          <a key={u} href={u} target="_blank" rel="noopener noreferrer"
                            className="text-magenta hover:underline px-1.5 py-0.5 rounded bg-magenta/10 border border-magenta/20"
                            aria-label={`Evidencia ${idx + 1} da denuncia ${REASON_LABEL[r.reason_code] || r.reason_code}`}
                            title={u}>
                            #{idx + 1}
                          </a>
                        ))}
                      </div>
                    )}
                    {/* FIX-WORKER-4 pass 7: forensics - quem/quando resolveu (status != open) */}
                    {r.status !== 'open' && (r.resolved_at || r.resolution_notes) && (
                      <div className="mt-2 pt-2 border-t border-white/5 text-xs text-white/50">
                        {r.resolved_at && <div>Resolvido em {fmtDate(r.resolved_at)}{r.resolved_by_email && ` por ${r.resolved_by_email}`}</div>}
                        {r.resolution_notes && <div className="mt-1 italic">"{r.resolution_notes}"</div>}
                      </div>
                    )}
                  </div>
                  {r.status === 'open' && (
                    <div className="flex gap-2 flex-shrink-0">
                      <button onClick={() => resolve(r.id, false)} disabled={action.busyKey === `resolve-${r.id}` || action.busyKey === `dismiss-${r.id}`}
                        className="text-green-400 hover:underline text-xs flex items-center gap-1 disabled:opacity-50 disabled:cursor-wait">
                        <Check className="w-3 h-3" aria-hidden="true" /> {action.busyKey === `resolve-${r.id}` ? '...' : 'Resolver'}
                      </button>
                      <button onClick={() => resolve(r.id, true)} disabled={action.busyKey === `resolve-${r.id}` || action.busyKey === `dismiss-${r.id}`}
                        className="text-white/40 hover:underline text-xs flex items-center gap-1 disabled:opacity-50 disabled:cursor-wait">
                        <X className="w-3 h-3" aria-hidden="true" /> {action.busyKey === `dismiss-${r.id}` ? '...' : 'Descartar'}
                      </button>
                    </div>
                  )}
                </div>
              </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
