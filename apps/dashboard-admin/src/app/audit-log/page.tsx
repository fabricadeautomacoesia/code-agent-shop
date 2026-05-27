'use client';

import { useEffect, useState } from 'react';
import { adminFetch, fmtDate } from '@/lib/admin-api';
import { FileText, Filter, ChevronLeft, ChevronRight } from 'lucide-react';

/**
 * FIX-WORKER-4 pass 12: /admin/audit-log dashboard.
 * Consume W14 pass 9 idx_audit_action_created via aiops-svc /audit-log endpoint.
 *
 * Features:
 * - Filter por action (dropdown via /audit-log/actions)
 * - Filter por severity
 * - Filter por janela (1d / 7d / 30d / 90d)
 * - Paginacao client-side (limit=50 + offset)
 * - Display: timestamp + actor + role + action + target + severity badge
 */

const SEVERITY_COLOR: Record<string, string> = {
  info:     'bg-blue-500/20 text-blue-300',
  warn:     'bg-yellow-500/20 text-yellow-300',
  error:    'bg-orange-500/20 text-orange-300',
  critical: 'bg-red-500/20 text-red-300',
};

const PAGE_SIZE = 50;

export default function AdminAuditLogPage() {
  const [entries, setEntries] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [actions, setActions] = useState<{ action: string; count: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  // Filtros
  const [filterAction, setFilterAction] = useState('');
  const [filterSeverity, setFilterSeverity] = useState('');
  const [filterDays, setFilterDays] = useState(7);
  const [offset, setOffset] = useState(0);

  async function load() {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      qs.set('days', String(filterDays));
      qs.set('limit', String(PAGE_SIZE));
      qs.set('offset', String(offset));
      if (filterAction) qs.set('action', filterAction);
      if (filterSeverity) qs.set('severity', filterSeverity);
      const r = await adminFetch<{ entries: any[]; total: number }>(`/aiops/audit-log?${qs}`);
      setEntries(r.entries || []);
      setTotal(r.total || 0);
      setLoadError('');
    } catch (e: any) {
      setLoadError(e.message);
      setEntries([]);
    } finally { setLoading(false); }
  }

  async function loadActions() {
    try {
      const r = await adminFetch<{ actions: { action: string; count: number }[] }>('/aiops/audit-log/actions');
      setActions(r.actions || []);
    } catch { /* silent */ }
  }

  useEffect(() => { load(); }, [filterAction, filterSeverity, filterDays, offset]);
  useEffect(() => { loadActions(); }, []);

  // Reset offset quando muda filtro
  useEffect(() => { setOffset(0); }, [filterAction, filterSeverity, filterDays]);

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div>
      <h1 className="font-display font-bold text-4xl mb-2">Audit log</h1>
      <p className="text-white/60 mb-6">Acoes de admins/sellers/sistema (retencao 90d, idx W14-9)</p>

      {/* Filtros */}
      <div className="glass p-4 mb-4 flex flex-wrap items-center gap-3">
        <Filter className="w-4 h-4 text-white/40" aria-hidden="true" />
        <select value={filterDays} onChange={(e) => setFilterDays(Number(e.target.value))}
          aria-label="Filtrar por periodo"
          className="text-xs px-3 py-1.5 rounded glass bg-transparent">
          <option value={1}>Ultimas 24h</option>
          <option value={7}>Ultimos 7d</option>
          <option value={30}>Ultimos 30d</option>
          <option value={90}>Ultimos 90d</option>
        </select>
        <select value={filterAction} onChange={(e) => setFilterAction(e.target.value)}
          aria-label="Filtrar por action"
          className="text-xs px-3 py-1.5 rounded glass bg-transparent max-w-xs">
          <option value="">Todas as actions</option>
          {actions.map((a) => (
            <option key={a.action} value={a.action}>{a.action} ({a.count})</option>
          ))}
        </select>
        <select value={filterSeverity} onChange={(e) => setFilterSeverity(e.target.value)}
          aria-label="Filtrar por severity"
          className="text-xs px-3 py-1.5 rounded glass bg-transparent">
          <option value="">Todas severidades</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
          <option value="critical">critical</option>
        </select>
        <div className="ml-auto text-xs text-white/40">
          {total > 0 ? `${total} registro(s) - pagina ${currentPage}/${totalPages}` : 'Sem registros'}
        </div>
      </div>

      {loadError && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg mb-4 flex items-center justify-between">
          <span>Erro: {loadError}</span>
          <button onClick={load} className="text-xs hover:underline">retry</button>
        </div>
      )}

      <div className="glass p-6 overflow-x-auto">
        {loading && !entries.length ? (
          <p className="text-white/60 text-center py-8">Carregando...</p>
        ) : entries.length === 0 ? (
          <div className="text-center py-12 text-white/60">
            <FileText className="w-16 h-16 mx-auto mb-4 text-white/20" aria-hidden="true" />
            <p>Nenhum registro com os filtros aplicados.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-white/40 uppercase border-b border-white/10">
              <tr>
                <th className="py-2">Quando</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Target</th>
                <th>Severidade</th>
                <th>Payload</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-b border-white/5 hover:bg-white/5">
                  <td className="py-2 text-xs text-white/60 whitespace-nowrap">{fmtDate(e.created_at)}</td>
                  <td className="text-xs">
                    <span className="font-mono text-white/70">{e.actor_user_id ? e.actor_user_id.slice(0, 8) : '-'}</span>
                    {e.actor_role && <span className="ml-1 text-[10px] text-white/40">({e.actor_role})</span>}
                  </td>
                  <td>
                    <span className="px-1.5 py-0.5 rounded bg-magenta/20 text-magenta-glow text-xs font-mono">
                      {e.action}
                    </span>
                  </td>
                  <td className="text-xs text-white/60">
                    {e.target_type && <span>{e.target_type}</span>}
                    {e.target_id && <span className="font-mono ml-1">{e.target_id.slice(0, 8)}</span>}
                  </td>
                  <td>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase font-bold ${SEVERITY_COLOR[e.severity] || 'bg-white/10 text-white/40'}`}>
                      {e.severity}
                    </span>
                  </td>
                  <td className="max-w-md">
                    <details className="text-xs">
                      <summary className="cursor-pointer text-white/50 hover:text-white">
                        ver
                      </summary>
                      <pre className="text-[10px] text-white/60 bg-black/30 p-2 rounded mt-1 overflow-x-auto max-h-32">
                        {JSON.stringify(e.payload_after || {}, null, 2)}
                      </pre>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Paginacao */}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between mt-4 px-2">
          <button onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            disabled={offset === 0 || loading}
            className="text-xs px-3 py-1.5 rounded glass hover:border-magenta/40 disabled:opacity-30 inline-flex items-center gap-1">
            <ChevronLeft className="w-3 h-3" aria-hidden="true" /> Anterior
          </button>
          <span className="text-xs text-white/60">
            Pagina {currentPage} de {totalPages}
          </span>
          <button onClick={() => setOffset(offset + PAGE_SIZE)}
            disabled={offset + PAGE_SIZE >= total || loading}
            className="text-xs px-3 py-1.5 rounded glass hover:border-magenta/40 disabled:opacity-30 inline-flex items-center gap-1">
            Proximo <ChevronRight className="w-3 h-3" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
