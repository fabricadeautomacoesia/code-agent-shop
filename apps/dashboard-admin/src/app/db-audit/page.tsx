'use client';

/**
 * FIX-WORKER-4: /admin/db-audit - auditoria de indices Postgres
 *
 * Consome endpoint W18 pass 8:
 *   GET /aiops/db/dead-indexes (admin-only)
 *
 * Pattern industry-standard: pos-2-weeks de prod stats, admin executa
 * audit, identifica idx com 0 scans, drop = storage saved + INSERTs +5x
 * por idx removido.
 *
 * SEMPRE leia warnings antes de drop manual via psql.
 */

import { useEffect, useState } from 'react';
import { adminFetch } from '@/lib/admin-api';
import { Database, AlertTriangle, Activity, TrendingDown, RefreshCw } from 'lucide-react';

const RECOMMENDATION_COLORS: Record<string, string> = {
  CANDIDATE_DROP: 'bg-red-500/20 text-red-300 border-red-500/30',
  LOW_USAGE: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
  ACTIVE: 'bg-green-500/20 text-green-300 border-green-500/30',
};

export default function DbAuditPage() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [activeTab, setActiveTab] = useState<'dead' | 'bloated' | 'top'>('dead');

  async function load() {
    setLoading(true);
    try {
      const r = await adminFetch<any>('/aiops/db/dead-indexes');
      setData(r);
      setLoadError('');
    } catch (e: any) {
      setLoadError(e?.message || 'Erro ao carregar audit');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="font-display font-bold text-4xl mb-2 flex items-center gap-3">
            <Database className="w-8 h-8 text-magenta" /> Auditoria de Indices DB
          </h1>
          <p className="text-white/60">
            Identifica indices mortos / redundantes / com bloat via{' '}
            <code className="text-magenta">pg_stat_user_indexes</code>.
          </p>
        </div>
        <button onClick={load} disabled={loading}
          className="btn-ghost text-sm inline-flex items-center gap-2 disabled:opacity-50">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Atualizar
        </button>
      </div>

      {loadError && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg mb-4">
          Erro: {loadError}
        </div>
      )}

      {!data && !loadError && (
        <div className="glass p-12 text-center text-white/50">
          <Database className="w-12 h-12 mx-auto mb-3 opacity-30" />
          Carregando audit...
        </div>
      )}

      {data && (
        <>
          {/* Summary cards */}
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <div className="glass p-4">
              <div className="text-xs text-white/40 uppercase mb-1 flex items-center gap-1.5">
                <TrendingDown className="w-3 h-3" /> Candidatos drop
              </div>
              <div className="text-2xl font-display font-bold text-red-400">{data.summary.dead_candidates}</div>
              <div className="text-xs text-white/40 mt-1">~{data.summary.total_dead_size_pretty} liberados</div>
            </div>
            <div className="glass p-4">
              <div className="text-xs text-white/40 uppercase mb-1 flex items-center gap-1.5">
                <AlertTriangle className="w-3 h-3" /> Low usage
              </div>
              <div className="text-2xl font-display font-bold text-yellow-400">{data.summary.low_usage}</div>
              <div className="text-xs text-white/40 mt-1">scans &lt; 50 - inspect</div>
            </div>
            <div className="glass p-4">
              <div className="text-xs text-white/40 uppercase mb-1 flex items-center gap-1.5">
                <Database className="w-3 h-3" /> Bloated
              </div>
              <div className="text-2xl font-display font-bold text-orange-400">{data.summary.bloated_indices}</div>
              <div className="text-xs text-white/40 mt-1">REINDEX recomendado</div>
            </div>
            <div className="glass p-4">
              <div className="text-xs text-white/40 uppercase mb-1 flex items-center gap-1.5">
                <Activity className="w-3 h-3" /> Total dead size
              </div>
              <div className="text-2xl font-display font-bold text-magenta-glow">{data.summary.total_dead_size_pretty}</div>
              <div className="text-xs text-white/40 mt-1">storage recuperavel</div>
            </div>
          </div>

          {/* Warnings */}
          <div className="bg-yellow-500/10 border-l-4 border-yellow-500 text-yellow-200 p-4 rounded-lg mb-6">
            <div className="font-semibold mb-2 text-sm flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" /> Avisos antes de DROP
            </div>
            <ul className="text-xs space-y-1 opacity-90 list-disc list-inside">
              {data.warnings.map((w: string, i: number) => <li key={i}>{w}</li>)}
            </ul>
          </div>

          {/* Tabs */}
          <div className="flex gap-2 mb-4 border-b border-white/10">
            {[
              { id: 'dead' as const, label: `Dead indices (${data.dead_indices.length})` },
              { id: 'bloated' as const, label: `Bloated (${data.bloated_indices.length})` },
              { id: 'top' as const, label: 'Top usage (sanity)' },
            ].map((t) => (
              <button key={t.id} onClick={() => setActiveTab(t.id)}
                className={`px-4 py-2 text-sm border-b-2 transition-colors ${
                  activeTab === t.id ? 'border-magenta text-magenta-glow' : 'border-transparent text-white/50 hover:text-white'
                }`}>
                {t.label}
              </button>
            ))}
          </div>

          {/* Dead/Low usage table */}
          {activeTab === 'dead' && (
            <div className="glass overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-white/40 uppercase border-b border-white/10">
                  <tr>
                    <th className="p-3">Schema</th>
                    <th>Table</th>
                    <th>Index</th>
                    <th>Size</th>
                    <th>Scans</th>
                    <th>Recommendation</th>
                  </tr>
                </thead>
                <tbody>
                  {data.dead_indices.length === 0 ? (
                    <tr><td colSpan={6} className="p-8 text-center text-white/40">
                      Nenhum dead index detectado. DB saudavel.
                    </td></tr>
                  ) : data.dead_indices.map((idx: any) => (
                    <tr key={idx.indexname} className="border-b border-white/5 hover:bg-white/5">
                      <td className="p-3 text-xs text-white/40">{idx.schemaname}</td>
                      <td className="font-mono text-xs">{idx.tablename}</td>
                      <td className="font-mono text-xs text-magenta">{idx.indexname}</td>
                      <td className="text-xs">{idx.size}</td>
                      <td className="text-xs font-mono">{idx.scans}</td>
                      <td>
                        <span className={`px-2 py-0.5 rounded text-[10px] uppercase font-bold border ${RECOMMENDATION_COLORS[idx.recommendation]}`}>
                          {idx.recommendation}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Bloated table */}
          {activeTab === 'bloated' && (
            <div className="glass overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-white/40 uppercase border-b border-white/10">
                  <tr>
                    <th className="p-3">Table</th>
                    <th>Index</th>
                    <th>Idx size</th>
                    <th>Table size</th>
                    <th>% of table</th>
                  </tr>
                </thead>
                <tbody>
                  {data.bloated_indices.length === 0 ? (
                    <tr><td colSpan={5} className="p-8 text-center text-white/40">
                      Sem bloat detectado.
                    </td></tr>
                  ) : data.bloated_indices.map((idx: any) => (
                    <tr key={idx.indexname} className="border-b border-white/5 hover:bg-white/5">
                      <td className="p-3 font-mono text-xs">{idx.tablename}</td>
                      <td className="font-mono text-xs text-magenta">{idx.indexname}</td>
                      <td className="text-xs">{idx.idx_size}</td>
                      <td className="text-xs text-white/60">{idx.table_size}</td>
                      <td className="text-xs">
                        <span className={idx.pct_of_table > 100 ? 'text-red-400 font-bold' : 'text-orange-400'}>
                          {idx.pct_of_table}%
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Top usage sanity */}
          {activeTab === 'top' && (
            <div className="glass overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-white/40 uppercase border-b border-white/10">
                  <tr>
                    <th className="p-3">Table</th>
                    <th>Index</th>
                    <th>Scans</th>
                    <th>Size</th>
                  </tr>
                </thead>
                <tbody>
                  {data.top_used.map((idx: any) => (
                    <tr key={idx.indexname} className="border-b border-white/5 hover:bg-white/5">
                      <td className="p-3 font-mono text-xs">{idx.tablename}</td>
                      <td className="font-mono text-xs text-magenta">{idx.indexname}</td>
                      <td className="text-xs font-mono text-green-400">{idx.scans.toLocaleString('pt-BR')}</td>
                      <td className="text-xs text-white/60">{idx.size}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="p-3 text-xs text-white/40 border-t border-white/10">
                Estes sao os 10 indices MAIS usados em prod. Sanity check: idx criticos do produto devem aparecer aqui.
              </div>
            </div>
          )}

          {data.generated_at && (
            <div className="text-xs text-white/30 mt-4 text-right">
              Gerado em: {new Date(data.generated_at).toLocaleString('pt-BR')}
            </div>
          )}
        </>
      )}
    </div>
  );
}
