'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle, AlertTriangle, Activity, Cpu, HardDrive, MemoryStick } from 'lucide-react';
import { Api } from '@/lib/api';

/**
 * Status page publica (V8 5.3).
 * Consome /api/aiops/status com refresh 10s.
 * FIX-WORKER-10 pass 5: removido XCircle/Database/StatusIcon - dependiam
 * de services{} e db detalhado que viraram DLP-only no admin.
 */

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

  // FIX-WORKER-10 pass 5: aiops sanitized agora retorna alerts_24h aggregate
  // { critical: N, error: N, warn: N, info: N } em vez de recent_alerts array completo.
  // Total = soma de severities (apenas counter, sem IDs/conteudo sensivel).
  const alerts24h = status.alerts_24h || {};
  const totalAlerts = Object.values(alerts24h).reduce((s: number, n: any) => s + (Number(n) || 0), 0);
  const criticalAlerts = (alerts24h.critical || 0) + (alerts24h.error || 0);
  const allOk = status.ok && totalAlerts === 0;
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
            : <><AlertTriangle className="w-8 h-8 text-yellow-400" /><div><div className="font-display font-bold text-2xl text-yellow-400">Atencao</div><div className="text-sm text-white/60">{totalAlerts} alerta(s) nas ultimas 24h{criticalAlerts > 0 ? ` (${criticalAlerts} critico)` : ''}</div></div></>
          }
        </div>
      </div>

      {/* FIX-WORKER-10 pass 5: removidos host/uptime/services{} (DLP - eram recon de infra).
          Mantido cards CPU/RAM/Disco (legitimo status page publica) sem detalhes internos.
          Servicos detalhados ficam no admin dashboard. */}
      <div className="glass p-6 mb-6">
        <h2 className="font-display font-bold text-xl mb-4 flex items-center gap-2">
          <Activity className="w-5 h-5 text-magenta" /> Recursos do servidor
        </h2>
        <div className="grid sm:grid-cols-3 gap-4">
          <MetricBar label="CPU" value={m.cpu_percent} threshold={85} Icon={Cpu} />
          <MetricBar label="RAM" value={m.ram_percent} threshold={90} Icon={MemoryStick} />
          <MetricBar label="Disco" value={m.disk_percent} threshold={90} Icon={HardDrive} />
        </div>
        {m.load_avg_1m !== undefined && (
          <div className="text-xs text-white/40 mt-4 pt-3 border-t border-white/5 text-center">
            Load average (1min): <span className="font-mono">{Number(m.load_avg_1m).toFixed(2)}</span>
          </div>
        )}
      </div>

      {/* FIX-WORKER-10 pass 5: alertas detalhados (com IDs/title) eram DLP leak (reporter UUIDs).
          Agora exibe agregado por severity (counter apenas). Detalhes ficam no admin dashboard. */}
      {totalAlerts > 0 && (
        <div className="glass p-6">
          <h2 className="font-display font-bold text-xl mb-4">Alertas nas ultimas 24h</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {(['critical','error','warn','info'] as const).map((sev) => {
              const n = alerts24h[sev] || 0;
              const color =
                sev === 'critical' ? 'bg-red-500/20 text-red-300 border-red-500/30' :
                sev === 'error'    ? 'bg-orange-500/20 text-orange-300 border-orange-500/30' :
                sev === 'warn'     ? 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30' :
                                     'bg-blue-500/20 text-blue-300 border-blue-500/30';
              return (
                <div key={sev} className={`rounded-lg border p-3 text-center ${color} ${n === 0 ? 'opacity-40' : ''}`}>
                  <div className="text-2xl font-bold font-display">{n}</div>
                  <div className="text-xs uppercase mt-1">{sev}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <p className="text-center text-xs text-white/40 mt-8">
        Powered by Inovare AIOps - <Link href="/" className="text-magenta hover:underline">Voltar para a vitrine</Link>
      </p>
    </div>
  );
}
