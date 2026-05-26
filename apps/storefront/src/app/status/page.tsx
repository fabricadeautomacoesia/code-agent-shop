'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle, AlertTriangle, XCircle, Activity, Database, Cpu, HardDrive, MemoryStick } from 'lucide-react';
import { Api } from '@/lib/api';

/**
 * Status page publica (V8 5.3).
 * Consome /api/aiops/status com refresh 10s.
 */

function StatusIcon({ ok }: { ok: boolean }) {
  if (ok) return <CheckCircle className="w-5 h-5 text-green-400" />;
  return <XCircle className="w-5 h-5 text-red-400" />;
}

function MetricBar({ label, value, max = 100, threshold = 85, Icon }: any) {
  const v = Number(value || 0);
  const pct = Math.min(100, (v / max) * 100);
  const color = v < threshold * 0.7 ? 'bg-green-400' : v < threshold ? 'bg-yellow-400' : 'bg-red-400';
  return (
    <div>
      <div className="flex items-center justify-between text-xs text-white/60 mb-1">
        <span className="flex items-center gap-2"><Icon className="w-3 h-3" /> {label}</span>
        <span className="font-mono">{v.toFixed(1)}%</span>
      </div>
      <div className="h-2 bg-white/5 rounded-full overflow-hidden">
        <div className={`h-full ${color} transition-all duration-500`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default function StatusPage() {
  const [status, setStatus] = useState<any>(null);
  const [err, setErr] = useState('');

  const load = () =>
    Api.api<any>('/aiops/status', { cache: 'no-store' })
      .then(setStatus)
      .catch((e) => setErr(e.message));

  useEffect(() => {
    load();
    const i = setInterval(load, 10000);
    return () => clearInterval(i);
  }, []);

  if (err) return <div className="container mx-auto px-6 py-16 text-center text-red-400">Erro ao carregar status: {err}</div>;
  if (!status) return <div className="container mx-auto px-6 py-16 text-center text-white/60">Carregando...</div>;

  const allOk = status.ok && (status.recent_alerts?.length || 0) === 0;
  const m = status.metrics || {};

  return (
    <div className="container mx-auto px-6 py-8 max-w-4xl">
      <Link href="/" className="text-sm text-white/60 hover:text-white">&larr; Voltar</Link>

      <div className="mt-4 mb-8">
        <h1 className="font-display font-bold text-4xl mb-2">Status do Sistema</h1>
        <p className="text-white/60">Monitor publico do Code & Agent Shop - atualizado a cada 10s</p>
      </div>

      <div className={`glass p-6 mb-6 border-l-4 ${allOk ? 'border-green-500' : 'border-yellow-500'}`}>
        <div className="flex items-center gap-3">
          {allOk
            ? <><CheckCircle className="w-8 h-8 text-green-400" /><div><div className="font-display font-bold text-2xl text-green-400">Operacional</div><div className="text-sm text-white/60">Todos os sistemas funcionando normalmente</div></div></>
            : <><AlertTriangle className="w-8 h-8 text-yellow-400" /><div><div className="font-display font-bold text-2xl text-yellow-400">Atencao</div><div className="text-sm text-white/60">{status.recent_alerts?.length || 0} alerta(s) nas ultimas 24h</div></div></>
          }
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-6 mb-6">
        <div className="glass p-6">
          <h2 className="font-display font-bold text-xl mb-4 flex items-center gap-2">
            <Activity className="w-5 h-5 text-magenta" /> Servidor (host {status.host})
          </h2>
          <div className="space-y-4">
            <MetricBar label="CPU" value={m.cpu_percent} threshold={85} Icon={Cpu} />
            <MetricBar label="RAM" value={m.ram_percent} threshold={90} Icon={MemoryStick} />
            <MetricBar label="Disco" value={m.disk_percent} threshold={90} Icon={HardDrive} />
            <div className="text-xs text-white/40 pt-2 border-t border-white/5 grid grid-cols-2 gap-2">
              <div>Uptime: {Math.floor((status.uptime_s || 0) / 3600)}h</div>
              <div>Load: {m.load_avg_1m?.toFixed(2)} / {m.load_avg_5m?.toFixed(2)} / {m.load_avg_15m?.toFixed(2)}</div>
              <div>RAM: {m.ram_used_mb?.toLocaleString() || 0} / {m.ram_total_mb?.toLocaleString() || 0} MB</div>
              <div>Disco: {m.disk_used_gb} / {m.disk_total_gb} GB</div>
            </div>
          </div>
        </div>

        <div className="glass p-6">
          <h2 className="font-display font-bold text-xl mb-4 flex items-center gap-2">
            <Database className="w-5 h-5 text-magenta" /> Microsservicos
          </h2>
          <div className="space-y-2 text-sm">
            {Object.entries(status.services || {}).map(([name, port]: any) => (
              <div key={name} className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
                <span className="flex items-center gap-2 capitalize">
                  <StatusIcon ok={true} /> {name}
                </span>
                <span className="text-xs text-white/40 font-mono">:{port}</span>
              </div>
            ))}
            <div className="flex items-center justify-between py-2 border-t border-white/10 pt-3 mt-2">
              <span className="flex items-center gap-2"><StatusIcon ok={status.db?.ok} /> PostgreSQL</span>
              <span className="text-xs text-white/40">{status.db?.ok ? 'OK' : 'FAIL'}</span>
            </div>
          </div>
        </div>
      </div>

      {status.recent_alerts?.length > 0 && (
        <div className="glass p-6">
          <h2 className="font-display font-bold text-xl mb-4">Alertas recentes (24h)</h2>
          <div className="space-y-2 text-sm">
            {status.recent_alerts.map((a: any) => (
              <div key={a.id} className="flex items-start gap-3 p-2 bg-white/5 rounded">
                <span className={`px-2 py-0.5 rounded text-xs font-bold ${
                  a.severity === 'critical' ? 'bg-red-500/30 text-red-300' :
                  a.severity === 'error'    ? 'bg-orange-500/30 text-orange-300' :
                  a.severity === 'warn'     ? 'bg-yellow-500/30 text-yellow-300' :
                                              'bg-blue-500/30 text-blue-300'
                }`}>{a.severity}</span>
                <div className="flex-1">
                  <div className="font-medium">{a.title}</div>
                  <div className="text-xs text-white/40">{new Date(a.created_at).toLocaleString('pt-BR')}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="text-center text-xs text-white/40 mt-8">
        Powered by Inovare AIOps - <Link href="/" className="text-magenta hover:underline">Voltar para a vitrine</Link>
      </p>
    </div>
  );
}
