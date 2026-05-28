'use client';

import { useEffect, useState } from 'react';
import { adminFetch, fmtDate } from '@/lib/admin-api';
import { RefreshCw, AlertTriangle, Clock, CheckCircle2, Database } from 'lucide-react';

/**
 * FIX-WORKER-4 pass 209: /admin/mv-kpi-refresh dashboard.
 * Consume W14 pass 208 endpoint POST /sellers/admin/mv-kpi/refresh
 * + GET /aiops/audit-log filtrado por action='mv_seller_kpi%'
 *
 * Features:
 * - Botao manual REFRESH com confirmacao
 * - Loading state + duration_ms feedback
 * - Historico ultimos 20 refresh events (cron + manual)
 * - Severity badge (info = success, critical = fail)
 * - Auto-refresh historico apos manual trigger
 *
 * Use cases:
 * - Apos mass platform-take admin clica refresh
 * - Apos payout grande processado
 * - Investigacao admin: KPI parece errado, force refresh
 */

type AuditEntry = {
  id: string;
  actor_user_id: string | null;
  action: string;
  severity: string;
  payload_after: any;
  created_at: string;
};

const SEVERITY_COLOR: Record<string, string> = {
  info: 'bg-blue-500/20 text-blue-300',
  warn: 'bg-yellow-500/20 text-yellow-300',
  error: 'bg-orange-500/20 text-orange-300',
  critical: 'bg-red-500/20 text-red-300',
};

export default function MvKpiRefreshPage() {
  const [history, setHistory] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [actionMsg, setActionMsg] = useState('');
  const [actionErr, setActionErr] = useState('');

  async function loadHistory() {
    setLoading(true);
    try {
      // Audit log filter action prefix mv_seller_kpi
      // (sem prefix filter no endpoint atual - usa includes em raw fetch)
      const r = await adminFetch<{ entries: AuditEntry[] }>('/aiops/audit-log?action=mv_seller_kpi.refresh&limit=20');
      // Mais entries: combina success + fail + manual
      const r2 = await adminFetch<{ entries: AuditEntry[] }>('/aiops/audit-log?action=mv_seller_kpi.refresh.fail&limit=10').catch(() => ({ entries: [] }));
      const r3 = await adminFetch<{ entries: AuditEntry[] }>('/aiops/audit-log?action=mv_seller_kpi.refresh.manual&limit=10').catch(() => ({ entries: [] }));
      const r4 = await adminFetch<{ entries: AuditEntry[] }>('/aiops/audit-log?action=mv_seller_kpi.refresh.manual.fail&limit=10').catch(() => ({ entries: [] }));
      const all = [...(r.entries || []), ...(r2.entries || []), ...(r3.entries || []), ...(r4.entries || [])];
      all.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      setHistory(all.slice(0, 30));
      setLoadError('');
    } catch (e: any) {
      setLoadError(e.message || 'Erro carregando historico');
    } finally {
      setLoading(false);
    }
  }

  async function triggerRefresh() {
    if (refreshing) return;
    const { confirmDialog } = await import('@/components/prompt-dialog');
    if (!await confirmDialog('Disparar REFRESH MATERIALIZED VIEW mv_seller_kpi? Operacao pesada CPU/IO (~500-2000ms).')) return;

    setRefreshing(true);
    setActionMsg('');
    setActionErr('');
    try {
      const r = await adminFetch<{ ok: boolean; refreshed: boolean; duration_ms: number }>(
        '/sellers/admin/mv-kpi/refresh', { method: 'POST' }
      );
      setActionMsg(`Refresh OK - ${r.duration_ms}ms`);
      setTimeout(() => loadHistory(), 1000); // delay p/ audit_log INSERT settle
    } catch (e: any) {
      // Detect 429 rate-limit
      if (e?.status === 429 || e?.data?.statusCode === 429) {
        setActionErr('Rate-limit atingido (5/h). Aguarde antes de novo refresh.');
      } else {
        setActionErr(e?.data?.message || e?.message || 'Erro ao disparar refresh');
      }
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => { loadHistory(); }, []);

  // Aggregate stats (last 7d)
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = history.filter((h) => new Date(h.created_at).getTime() > sevenDaysAgo);
  const successCount = recent.filter((h) => h.severity === 'info').length;
  const failCount = recent.filter((h) => h.severity === 'critical' || h.severity === 'error').length;
  const lastSuccess = history.find((h) => h.severity === 'info');

  return (
    <div>
      <h1 className="font-display font-bold text-4xl mb-2">MV KPI Refresh</h1>
      <p className="text-white/60 mb-6">
        Manual REFRESH MATERIALIZED VIEW mv_seller_kpi + historico cron noturno + manual triggers.
      </p>

      {/* STATS CARDS */}
      <div className="grid md:grid-cols-3 gap-4 mb-8">
        <div className="glass p-5">
          <div className="stat-label flex items-center gap-2"><CheckCircle2 className="w-3 h-3" aria-hidden="true" /> Sucesso 7d</div>
          <div className="stat-value text-green-400">{successCount}</div>
        </div>
        <div className="glass p-5">
          <div className="stat-label flex items-center gap-2"><AlertTriangle className="w-3 h-3" aria-hidden="true" /> Falhas 7d</div>
          <div className="stat-value text-red-400">{failCount}</div>
        </div>
        <div className="glass p-5">
          <div className="stat-label flex items-center gap-2"><Clock className="w-3 h-3" aria-hidden="true" /> Ultimo sucesso</div>
          <div className="text-sm text-white/70">
            {lastSuccess ? fmtDate(lastSuccess.created_at) : 'sem registros'}
          </div>
          {lastSuccess?.payload_after?.refresh_duration_ms && (
            <div className="text-xs text-white/40 mt-1">{lastSuccess.payload_after.refresh_duration_ms}ms</div>
          )}
        </div>
      </div>

      {/* ACTION BUTTON */}
      <div className="glass p-6 mb-8">
        <h2 className="font-display font-bold text-xl mb-4 flex items-center gap-2">
          <Database className="w-5 h-5" aria-hidden="true" />
          Trigger manual refresh
        </h2>
        <p className="text-sm text-white/60 mb-4">
          Use apos eventos disruptivos (mass platform-take, payout grande, bulk class promotion).
          Limitado a 5 refreshes/hora (operacao pesada CPU/IO).
        </p>
        <button type="button" onClick={triggerRefresh} disabled={refreshing}
          aria-label="Disparar refresh manual do mv_seller_kpi"
          className="btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-wait focus-visible:outline-2 focus-visible:outline-magenta">
          <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
          {refreshing ? 'Executando refresh...' : 'Disparar REFRESH agora'}
        </button>
        {actionMsg && (
          <div role="status" aria-live="polite" className="mt-3 p-3 rounded-lg bg-green-500/10 border border-green-500/30 text-green-300 text-sm flex items-start justify-between gap-2">
            <span>{actionMsg}</span>
            <button type="button" onClick={() => setActionMsg('')}
              aria-label="Fechar mensagem de sucesso"
              className="text-xs hover:underline focus-visible:outline-2 focus-visible:outline-green-400 rounded">fechar</button>
          </div>
        )}
        {actionErr && (
          <div role="alert" className="mt-3 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-sm flex items-start justify-between gap-2">
            <span>{actionErr}</span>
            <button type="button" onClick={() => setActionErr('')}
              aria-label="Fechar mensagem de erro"
              className="text-xs hover:underline focus-visible:outline-2 focus-visible:outline-red-400 rounded">fechar</button>
          </div>
        )}
      </div>

      {/* HISTORICO */}
      <div className="glass p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-display font-bold text-xl flex items-center gap-2">
            <Clock className="w-5 h-5" aria-hidden="true" />
            Historico ultimos refreshes
          </h2>
          <button type="button" onClick={loadHistory} disabled={loading}
            aria-label="Recarregar historico"
            className="text-xs px-3 py-1.5 rounded-lg glass hover:border-magenta/40 transition-colors disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-magenta">
            {loading ? 'Atualizando...' : 'Atualizar'}
          </button>
        </div>

        {loadError && (
          <div role="alert" className="bg-red-500/10 border border-red-500/30 text-red-400 p-3 rounded-lg mb-4 text-sm">
            {loadError}
          </div>
        )}

        {loading && history.length === 0 ? (
          <p className="text-white/60 text-center py-8">Carregando...</p>
        ) : history.length === 0 ? (
          <p className="text-white/60 text-center py-8">
            Sem refresh historico. Aguarde proximo cron 3:03 AM ou dispare manual acima.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-white/40 uppercase border-b border-white/10">
              <tr>
                <th className="py-2">Quando</th>
                <th>Tipo</th>
                <th>Severity</th>
                <th>Duration</th>
                <th>Sellers</th>
                <th>Actor</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => {
                const isManual = h.action.includes('manual');
                const isFail = h.action.includes('fail');
                const p = h.payload_after || {};
                return (
                  <tr key={h.id} className="border-b border-white/5 hover:bg-white/5">
                    <td className="py-3 text-xs text-white/60">{fmtDate(h.created_at)}</td>
                    <td>
                      <span className={`px-2 py-0.5 rounded text-xs uppercase font-bold ${
                        isManual ? 'bg-magenta/20 text-magenta-glow' : 'bg-blue-500/20 text-blue-300'
                      }`}>
                        {isManual ? 'Manual' : 'Cron'}
                      </span>
                    </td>
                    <td>
                      <span className={`px-2 py-0.5 rounded text-xs ${SEVERITY_COLOR[h.severity] || 'bg-white/10 text-white/60'}`}>
                        {h.severity}
                      </span>
                    </td>
                    <td className="text-xs font-mono">
                      {p.duration_ms || p.refresh_duration_ms || '-'}{p.duration_ms || p.refresh_duration_ms ? 'ms' : ''}
                    </td>
                    <td className="text-xs">
                      {p.sellers_total ? `${p.sellers_ok || 0}/${p.sellers_total}` : '-'}
                    </td>
                    <td className="text-xs text-white/50">
                      {h.actor_user_id ? h.actor_user_id.slice(0, 8) : 'cron'}
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
