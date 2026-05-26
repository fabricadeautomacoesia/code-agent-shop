'use client';

import { useEffect, useState } from 'react';
import { adminFetch, fmtDate } from '@/lib/admin-api';
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
  const [error, setError] = useState('');

  async function load() {
    try {
      const r = await adminFetch<{ reports: any[] }>(`/reviews/admin/reports?status=${filter}`);
      setReports(r.reports || []);
    } catch (e: any) {
      setError(e.message);
    }
  }
  useEffect(() => { load(); }, [filter]);

  async function resolve(id: string, dismissed = false) {
    const notes = prompt(dismissed ? 'Justificativa para descartar:' : 'Notas da resolucao:');
    if (!notes) return;
    await adminFetch(`/reviews/reports/${id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ status: dismissed ? 'dismissed' : 'resolved', notes }),
    });
    load();
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

      {error && <div className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg mb-4">{error}</div>}

      <div className="glass p-6">
        {reports.length === 0 ? (
          <p className="text-white/60 text-center py-12 flex items-center justify-center gap-2">
            <AlertOctagon className="w-5 h-5 text-green-400" /> Nenhuma denuncia neste filtro. Sistema limpo.
          </p>
        ) : (
          <div className="space-y-3">
            {reports.map((r) => (
              <div key={r.id} className="border-l-4 border-yellow-500 p-4 bg-white/5 rounded">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-400 text-xs uppercase">
                        {REASON_LABEL[r.reason_code] || r.reason_code}
                      </span>
                      <span className="text-xs text-white/40">{r.target_type}#{r.target_id?.slice(0, 8)}</span>
                      <span className="text-xs text-white/40">{fmtDate(r.created_at)}</span>
                    </div>
                    {r.description && <p className="text-sm text-white/80 mb-2">{r.description}</p>}
                    {r.evidence_urls?.length > 0 && (
                      <div className="text-xs text-white/50">
                        Evidencias: {r.evidence_urls.map((u: string) => <a key={u} href={u} target="_blank" className="text-magenta hover:underline mr-2">link</a>)}
                      </div>
                    )}
                  </div>
                  {r.status === 'open' && (
                    <div className="flex gap-2">
                      <button onClick={() => resolve(r.id, false)} className="text-green-400 hover:underline text-xs flex items-center gap-1">
                        <Check className="w-3 h-3" /> Resolver
                      </button>
                      <button onClick={() => resolve(r.id, true)} className="text-white/40 hover:underline text-xs flex items-center gap-1">
                        <X className="w-3 h-3" /> Descartar
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
