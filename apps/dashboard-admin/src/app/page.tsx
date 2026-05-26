'use client';

import { useEffect, useState } from 'react';

async function fetchJSON(url: string) {
  try { const r = await fetch(url, { credentials: 'include', cache: 'no-store' }); return r.ok ? r.json() : null; } catch { return null; }
}

export default function AdminHome() {
  const [status, setStatus] = useState<any>(null);

  useEffect(() => {
    fetchJSON('/api/aiops/status').then(setStatus);
    const i = setInterval(() => fetchJSON('/api/aiops/status').then(setStatus), 10000);
    return () => clearInterval(i);
  }, []);

  return (
    <div>
      <h1 className="font-display font-bold text-4xl mb-2">Visao Geral</h1>
      <p className="text-white/60 mb-8">Console de operacao do Code & Agent Shop</p>

      <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <div className="stat-card">
          <div className="stat-label">CPU</div>
          <div className="stat-value">{status?.metrics?.cpu_percent?.toFixed(1) ?? '-'}%</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">RAM</div>
          <div className="stat-value">{status?.metrics?.ram_percent?.toFixed(1) ?? '-'}%</div>
          <div className="text-xs text-white/40 mt-1">{status?.metrics?.ram_used_mb ?? '-'} / {status?.metrics?.ram_total_mb ?? '-'} MB</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Disco</div>
          <div className="stat-value">{status?.metrics?.disk_percent?.toFixed(1) ?? '-'}%</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Uptime</div>
          <div className="stat-value">{status?.uptime_s ? Math.floor(status.uptime_s/3600)+'h' : '-'}</div>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        <div className="glass p-6">
          <h2 className="font-display font-bold text-xl mb-4">Servicos</h2>
          {status?.services ? (
            <div className="space-y-2 text-sm font-mono">
              {Object.entries(status.services).map(([name, port]) => (
                <div key={name} className="flex justify-between py-2 border-b border-white/5">
                  <span className="capitalize">{name}</span>
                  <span className="text-white/40">:{port as number}</span>
                </div>
              ))}
            </div>
          ) : <div className="text-white/40">Carregando...</div>}
        </div>

        <div className="glass p-6">
          <h2 className="font-display font-bold text-xl mb-4">Alertas recentes (24h)</h2>
          {status?.recent_alerts?.length > 0 ? (
            <div className="space-y-2 text-sm">
              {status.recent_alerts.map((a: any) => (
                <div key={a.id} className="flex items-start gap-3 p-2 rounded hover:bg-white/5">
                  <span className={`px-2 py-0.5 rounded text-xs font-semibold ${
                    a.severity === 'critical' ? 'bg-red-500/20 text-red-400' :
                    a.severity === 'error'    ? 'bg-orange-500/20 text-orange-400' :
                    a.severity === 'warn'     ? 'bg-yellow-500/20 text-yellow-400' :
                                                'bg-blue-500/20 text-blue-400'
                  }`}>{a.severity}</span>
                  <div className="flex-1">
                    <div className="font-medium">{a.title}</div>
                    <div className="text-xs text-white/40">{new Date(a.created_at).toLocaleString('pt-BR')}</div>
                  </div>
                </div>
              ))}
            </div>
          ) : <div className="text-green-400 text-sm">Nenhum alerta. Sistema saudavel.</div>}
        </div>
      </div>
    </div>
  );
}
