'use client';

import { useEffect, useState } from 'react';
import { adminFetch, fmtDate } from '@/lib/admin-api';

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<any[]>([]);

  useEffect(() => {
    const load = () => adminFetch<{ alerts: any[] }>('/aiops/alerts/recent')
      .then((r) => setAlerts(r.alerts || []))
      .catch(() => {});
    load();
    const i = setInterval(load, 15000);
    return () => clearInterval(i);
  }, []);

  const severityColors: Record<string, string> = {
    critical: 'bg-red-500/30 text-red-300 border-red-500',
    error:    'bg-orange-500/20 text-orange-400 border-orange-500/50',
    warn:     'bg-yellow-500/20 text-yellow-400 border-yellow-500/50',
    info:     'bg-blue-500/20 text-blue-400 border-blue-500/50',
  };

  return (
    <div>
      <h1 className="font-display font-bold text-4xl mb-2">Alertas AIOps</h1>
      <p className="text-white/60 mb-8">Ultimos 7 dias - auto-refresh 15s</p>

      <div className="space-y-2">
        {alerts.length === 0 ? (
          <div className="glass p-8 text-center text-green-400">Nenhum alerta nos ultimos 7 dias. Sistema saudavel.</div>
        ) : alerts.map((a) => (
          <div key={a.id} className={`glass border-l-4 p-4 flex items-start gap-4 ${severityColors[a.severity] || severityColors.info}`}>
            <div className="px-2 py-1 rounded text-xs font-bold uppercase">{a.severity}</div>
            <div className="flex-1">
              <div className="font-display font-semibold">{a.title}</div>
              <div className="text-sm text-white/70 mt-1">{a.message}</div>
              <div className="text-xs text-white/40 mt-2">
                <span className="font-mono">[{a.source}/{a.code}]</span> - {fmtDate(a.created_at)}
                {a.target_type && <> - target: {a.target_type}#{(a.target_id || '').slice(0, 8)}</>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
