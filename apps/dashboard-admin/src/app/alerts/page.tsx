'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminFetch, fmtDate } from '@/lib/admin-api';
import { useAdminAction } from '@/lib/use-admin-action';
import { CheckCircle2, Filter, X } from 'lucide-react';

/* FIX-WORKER-4 pass 483 (consume pass 432 backend filters + pass 482 acknowledge):
   PRE-FIX: page minimal - apenas auto-poll /alerts/recent sem filters/mutations.
   - Pass 432 backend ja suportava ?severity + ?source + ?acknowledged
   - Pass 482 backend ja suportava POST /alerts/:id/acknowledge
   - UI tinha ZERO consume - admin sem capacidade ack via dashboard
   - Workflow loop quebrado: ver alerts -> psql direto OR esperar TTL
   POST-FIX:
   - + Filter UI (severity dropdown + source input + ack toggle)
   - + acknowledge button per row (icon Check)
   - + Toggle "show acked" - default oculta
   - + role=alert para banners status (a11y)
   - Loop fechado: list -> filter -> ack -> auto-refresh */

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'bg-red-500/30 text-red-300 border-red-500',
  error:    'bg-orange-500/20 text-orange-400 border-orange-500/50',
  warn:     'bg-yellow-500/20 text-yellow-400 border-yellow-500/50',
  info:     'bg-blue-500/20 text-blue-400 border-blue-500/50',
};

const SEVERITY_OPTIONS = ['', 'info', 'warn', 'error', 'critical'];

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<any[]>([]);
  const [loadError, setLoadError] = useState('');
  // Filters (consume pass 432 backend)
  const [filterSeverity, setFilterSeverity] = useState('');
  const [filterSource, setFilterSource] = useState('');
  // Default oculta ja acked - admin foca em pendentes
  const [showAcked, setShowAcked] = useState(false);

  /* FIX-WORKER-4 pass 742 (useCallback stable closure - paridade cadeia 738-741 React stability):
     PRE-FIX BUG: async function load() recriada cada render referencia 3 filter states.
     - setInterval(load, 15000) captura closure stale - cron 15s usa SNAPSHOT
       de filter state da render que criou interval
     - useEffect deps [filterSeverity, filterSource, showAcked] re-roda cleanup+create
       interval per filter change - OK funcional MAS:
       * useAdminAction(load) recebe nova reference cada render -> action.run re-criada
       * useAdminAction useCallback deps [busyKey, reload] -> reload muda -> run muda
     - Hot path /alerts dashboard poll 15s + filter mutations -> cascading re-renders
     POST-FIX:
     - useCallback wrap em load com [filterSeverity, filterSource, showAcked] deps
     - useEffect deps [load] (paridade ESLint exhaustive-deps)
     - setInterval captura load atual (useCallback referencia mantida)
     - useAdminAction recebe stable callback -> action.run estavel
     Pattern V8 React stability cadeia 5 sites cross-dashboard:
     - 738 disputes, 739 payouts-pending, 740 financeiro, 741 loja, 742 alerts. */
  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      if (filterSeverity) qs.set('severity', filterSeverity);
      if (filterSource) qs.set('source', filterSource);
      // Default acknowledged=false (so unacked) - admin workflow priority
      if (!showAcked) qs.set('acknowledged', 'false');
      const url = `/aiops/alerts/recent${qs.toString() ? '?' + qs : ''}`;
      const r = await adminFetch<{ alerts: any[] }>(url);
      setAlerts(r.alerts || []);
      setLoadError('');
    } catch (e: any) {
      setLoadError(e?.message || 'Erro carregando alertas');
      setAlerts([]);
    }
  }, [filterSeverity, filterSource, showAcked]);

  useEffect(() => {
    load();
    const i = setInterval(load, 15000);
    return () => clearInterval(i);
  }, [load]);

  // FIX pass 483: acknowledge action (consume pass 482 POST endpoint)
  const action = useAdminAction(load);
  async function acknowledge(id: number, title: string) {
    action.run(`ack-${id}`, async () => {
      await adminFetch(`/aiops/alerts/${id}/acknowledge`, { method: 'POST' });
      return `Alert "${title.slice(0, 40)}" acknowledged`;
    });
  }

  return (
    <div>
      <h1 className="font-display font-bold text-4xl mb-2">Alertas AIOps</h1>
      <p className="text-white/60 mb-6">Ultimos 7 dias - auto-refresh 15s</p>

      {/* Filters bar (consume pass 432 backend filters) */}
      <div className="glass p-4 mb-4 flex flex-wrap items-center gap-3">
        <Filter className="w-4 h-4 text-white/40" aria-hidden="true" />
        <select value={filterSeverity} onChange={(e) => setFilterSeverity(e.target.value)}
          aria-label="Filtrar por severity"
          className="text-xs px-3 py-1.5 rounded glass bg-transparent">
          {SEVERITY_OPTIONS.map((s) => (
            <option key={s || 'all'} value={s}>{s || 'Todas severidades'}</option>
          ))}
        </select>
        <input value={filterSource} onChange={(e) => setFilterSource(e.target.value)}
          placeholder="source (aiops, fail2ban, spike-detector...)"
          aria-label="Filtrar por source"
          maxLength={60}
          className="text-xs px-3 py-1.5 rounded glass bg-transparent w-64" />
        <label className="text-xs flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={showAcked} onChange={(e) => setShowAcked(e.target.checked)} />
          Mostrar acked
        </label>
        <div className="ml-auto text-xs text-white/40">
          {alerts.length} alerta(s)
        </div>
      </div>

      {/* Banners action a11y (paridade outros admin pages) */}
      {loadError && (
        <div role="alert" className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg mb-4 flex items-center justify-between">
          <span>Erro: {loadError}</span>
          <button type="button" onClick={() => { setLoadError(''); load(); }}
            aria-label="Tentar carregar novamente"
            className="text-xs hover:underline focus-visible:outline-2 focus-visible:outline-red-400 rounded">retry</button>
        </div>
      )}
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

      <div className="space-y-2">
        {alerts.length === 0 ? (
          <div className="glass p-8 text-center text-green-400">
            {loadError ? 'Falha ao carregar alertas.'
             : showAcked ? 'Nenhum alerta nos ultimos 7 dias.'
             : 'Nenhum alerta pendente. Sistema saudavel.'}
          </div>
        ) : alerts.map((a) => {
          const isAcked = !!a.acknowledged_at;
          const busy = action.busyKey === `ack-${a.id}`;
          return (
            <div key={a.id} className={`glass border-l-4 p-4 flex items-start gap-4 ${SEVERITY_COLORS[a.severity] || SEVERITY_COLORS.info} ${isAcked ? 'opacity-60' : ''}`}>
              <div className="px-2 py-1 rounded text-xs font-bold uppercase">{a.severity}</div>
              <div className="flex-1">
                <div className="font-display font-semibold flex items-center gap-2">
                  {a.title}
                  {isAcked && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-400 inline-flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" aria-hidden="true" /> acked
                    </span>
                  )}
                </div>
                <div className="text-sm text-white/70 mt-1">{a.message}</div>
                <div className="text-xs text-white/40 mt-2">
                  <span className="font-mono">[{a.source}/{a.code}]</span> - {fmtDate(a.created_at)}
                  {a.target_type && <> - target: {a.target_type}#{(a.target_id || '').slice(0, 8)}</>}
                  {isAcked && <> - acked em {fmtDate(a.acknowledged_at)}</>}
                </div>
              </div>
              {!isAcked && (
                <button type="button" onClick={() => acknowledge(a.id, a.title)}
                  disabled={busy}
                  aria-label={`Acknowledge alerta ${a.title}`}
                  className="text-green-400 hover:bg-green-500/10 text-xs inline-flex items-center gap-1 px-3 py-1.5 rounded border border-green-500/30 hover:border-green-500/60 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-green-400">
                  <CheckCircle2 className="w-3 h-3" aria-hidden="true" />
                  {busy ? '...' : 'Ack'}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
