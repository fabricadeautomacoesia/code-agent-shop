'use client';

import { useEffect, useState } from 'react';
import { adminFetch } from '@/lib/admin-api';
import { Cpu, TrendingUp, Zap, AlertTriangle } from 'lucide-react';

/**
 * FIX-WORKER-4 pass 194: /admin/llm-cost dashboard.
 * Consume W4 pass 193 endpoint /aiops/llm-cost.
 *
 * Features:
 * - Total 30d spend (USD cents)
 * - Provider/model table (calls, total, avg, max cents, tokens, latency)
 * - Success rate (approved/rejected/failed)
 * - Daily sparkline (visual textual)
 *
 * Use cases:
 * - Identificar provider mais caro
 * - Detectar spike anomalo (gasto subito)
 * - Forecasting mensal projetado
 */

type CostResponse = {
  window_days: number;
  total: {
    total_calls: number;
    total_cents: number;
    approved: number;
    rejected: number;
    failed: number;
  };
  by_provider: Array<{
    llm_provider: string;
    llm_model: string;
    calls: number;
    total_cents: number;
    avg_cents: number;
    max_cents: number;
    total_input_tokens: number;
    total_output_tokens: number;
    avg_duration_ms: number;
  }>;
  daily: Array<{ day: string; calls: number; total_cents: number }>;
};

function fmtUSD(cents: number | null | undefined): string {
  const n = Number(cents) || 0;
  return `$${(n / 100).toFixed(2)}`;
}

function fmtTokens(n: number | null | undefined): string {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  if (v < 1_000_000) return `${(v / 1000).toFixed(1)}K`;
  return `${(v / 1_000_000).toFixed(2)}M`;
}

export default function LlmCostPage() {
  const [data, setData] = useState<CostResponse | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const r = await adminFetch<CostResponse>('/aiops/llm-cost');
      setData(r);
      setLoadError('');
    } catch (e: any) {
      setLoadError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const total = data?.total;
  const successRate =
    total && total.total_calls > 0
      ? ((total.approved / total.total_calls) * 100).toFixed(1)
      : '0.0';

  // Projecao mensal: extrapolar gasto medio dos ultimos 30d para 30d futuros
  const projectedMonthly = total?.total_cents ?? 0;

  // Max daily para sparkline scale
  const maxDaily = data?.daily?.length
    ? Math.max(...data.daily.map((d) => Number(d.total_cents) || 0))
    : 0;

  return (
    <div>
      <h1 className="font-display font-bold text-4xl mb-2">LLM Cost Observability</h1>
      <p className="text-white/60 mb-6">
        Custos QA pipeline (OpenAI/Gemini/Groq) - ultimos 30 dias
      </p>

      {/* FIX-WORKER-4 pass 194 (a11y V8 R23): role=alert + close button */}
      {loadError && (
        <div role="alert" className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg mb-4 flex items-center justify-between">
          <span className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" aria-hidden="true" />
            Erro carregando dados: {loadError}
          </span>
          <button type="button" onClick={load}
            aria-label="Tentar carregar dados novamente"
            className="text-xs hover:underline focus-visible:outline-2 focus-visible:outline-red-400 rounded">retry</button>
        </div>
      )}

      {loading && !data ? (
        <div className="glass p-12 text-center text-white/60">Carregando...</div>
      ) : !data ? (
        <div className="glass p-12 text-center text-white/60">Sem dados disponiveis</div>
      ) : (
        <>
          {/* TOTAL CARDS */}
          <div className="grid md:grid-cols-4 gap-4 mb-8">
            <div className="glass p-5">
              <div className="stat-label flex items-center gap-2"><TrendingUp className="w-3 h-3" aria-hidden="true" /> Total gasto (30d)</div>
              <div className="stat-value text-magenta-glow">{fmtUSD(total?.total_cents)}</div>
              <div className="text-xs text-white/40 mt-1">{total?.total_calls || 0} chamadas LLM</div>
            </div>
            <div className="glass p-5">
              <div className="stat-label flex items-center gap-2"><Zap className="w-3 h-3" aria-hidden="true" /> Aprovado</div>
              <div className="stat-value text-green-400">{total?.approved || 0}</div>
              <div className="text-xs text-white/40 mt-1">{successRate}% success rate</div>
            </div>
            <div className="glass p-5">
              <div className="stat-label">Rejeitado</div>
              <div className="stat-value text-yellow-400">{total?.rejected || 0}</div>
            </div>
            <div className="glass p-5">
              <div className="stat-label">Falhas (error/timeout)</div>
              <div className="stat-value text-red-400">{total?.failed || 0}</div>
              <div className="text-xs text-white/40 mt-1">Forecast 30d: {fmtUSD(projectedMonthly)}</div>
            </div>
          </div>

          {/* PROVIDER TABLE */}
          <div className="glass p-6 mb-8">
            <h2 className="font-display font-bold text-xl mb-4 flex items-center gap-2">
              <Cpu className="w-4 h-4" aria-hidden="true" />
              Por Provider / Model
            </h2>
            {data.by_provider.length === 0 ? (
              <p className="text-white/60 text-center py-8">Sem dados de provider nos ultimos 30 dias.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-white/40 uppercase border-b border-white/10">
                  <tr>
                    <th className="py-2">Provider</th>
                    <th>Model</th>
                    <th className="text-right">Calls</th>
                    <th className="text-right">Total</th>
                    <th className="text-right">Avg</th>
                    <th className="text-right">Max</th>
                    <th className="text-right">Input tokens</th>
                    <th className="text-right">Output tokens</th>
                    <th className="text-right">Avg ms</th>
                  </tr>
                </thead>
                <tbody>
                  {data.by_provider.map((p) => (
                    <tr key={`${p.llm_provider}-${p.llm_model}`} className="border-b border-white/5 hover:bg-white/5">
                      <td className="py-3">
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-white/10 text-xs uppercase font-bold">
                          {p.llm_provider}
                        </span>
                      </td>
                      <td className="text-xs font-mono text-white/70">{p.llm_model}</td>
                      <td className="text-right font-mono">{p.calls}</td>
                      <td className="text-right font-display font-bold text-magenta-glow">{fmtUSD(p.total_cents)}</td>
                      <td className="text-right text-xs text-white/60">{fmtUSD(p.avg_cents)}</td>
                      <td className="text-right text-xs text-white/60">{fmtUSD(p.max_cents)}</td>
                      <td className="text-right text-xs">{fmtTokens(p.total_input_tokens)}</td>
                      <td className="text-right text-xs">{fmtTokens(p.total_output_tokens)}</td>
                      <td className="text-right text-xs">{p.avg_duration_ms}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* DAILY SPARKLINE (textual chart) */}
          <div className="glass p-6">
            <h2 className="font-display font-bold text-xl mb-4">Gasto diario</h2>
            {data.daily.length === 0 ? (
              <p className="text-white/60 text-center py-8">Sem dados diarios.</p>
            ) : (
              <div className="space-y-1">
                {data.daily.map((d) => {
                  const cents = Number(d.total_cents) || 0;
                  const widthPct = maxDaily > 0 ? (cents / maxDaily) * 100 : 0;
                  return (
                    <div key={d.day} className="flex items-center gap-3 text-xs">
                      <span className="text-white/60 font-mono w-24">{d.day}</span>
                      <div className="flex-1 h-5 bg-white/5 rounded overflow-hidden">
                        <div className="h-full bg-gradient-to-r from-magenta to-violet-deep"
                          style={{ width: `${widthPct}%` }}
                          aria-label={`${d.calls} calls, ${fmtUSD(cents)}`} />
                      </div>
                      <span className="text-white/60 w-16 text-right font-mono">{fmtUSD(cents)}</span>
                      <span className="text-white/40 w-12 text-right text-[10px]">{d.calls}c</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
