'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import { adminFetch, fmtBRL, fmtDate } from '@/lib/admin-api';
import { useAdminAction } from '@/lib/use-admin-action';
import { Archive, Award, ExternalLink, Eye, FileEdit } from 'lucide-react';

// FIX-WORKER-4 pass 13: badge cor-coded por status (era hardcoded "approved" verde)
const STATUS_COLOR: Record<string, string> = {
  approved:    'bg-green-500/20 text-green-400',
  qa_pending:  'bg-yellow-500/20 text-yellow-400',
  qa_running:  'bg-blue-500/20 text-blue-300',
  rejected:    'bg-red-500/20 text-red-400',
  draft:       'bg-gray-500/20 text-gray-300',
  archived:    'bg-white/10 text-white/40',
  paused:      'bg-orange-500/20 text-orange-400',
};

export default function AdminProductsPage() {
  const [products, setProducts] = useState<any[]>([]);
  // FIX-WORKER-4 pass 13: filter UI funcional (era state morto sem dropdown)
  const [filter, setFilter] = useState('approved');
  const [loadError, setLoadError] = useState('');

  async function load() {
    try {
      const r = await adminFetch<{ results?: any[]; products?: any[] }>(
        `/search?limit=100${filter ? `&status=${filter}` : ''}`
      );
      setProducts(r.results || r.products || []);
      setLoadError('');
    } catch (e: any) { setLoadError(e.message); }
  }
  useEffect(() => { load(); }, [filter]);

  // FIX-WORKER-4 pass 3: useAdminAction hook (W4 pass 2 pattern)
  const action = useAdminAction(load);

  async function archive(id: string) {
    const { confirmDialog } = await import('@/components/prompt-dialog');
    if (!await confirmDialog('Arquivar este produto?', { variant: 'danger', confirmLabel: 'Arquivar' })) return;
    action.run(`archive-${id}`, async () => {
      await adminFetch(`/products/admin/${id}/archive`, { method: 'POST' });
      return `Produto ${id.slice(0, 8)}... arquivado`;
    });
  }
  async function platformTake(id: string) {
    const { confirmDialog, promptDialog } = await import('@/components/prompt-dialog');
    if (!await confirmDialog('Acionar Clausula Master?', { body: 'Vai criar copia 100% plataforma.', variant: 'danger', confirmLabel: 'Acionar' })) return;
    const reason = await promptDialog('Justificativa:', 'Ex: produto abandonado, vendedor inadimplente');
    if (!reason) return;
    action.run(`take-${id}`, async () => {
      await adminFetch(`/products/admin/${id}/platform-take`, { method: 'POST', body: JSON.stringify({ reason }) });
      return `Platform-take ${id.slice(0, 8)}... criado`;
    });
  }

  return (
    <div>
      <div className="flex justify-between items-end mb-8">
        <div>
          <h1 className="font-display font-bold text-4xl mb-2">Produtos</h1>
          {/* FIX-WORKER-4 pass 13: count claro - "exibindo X" vs "100 produtos" enganoso quando ha 500+ */}
          <p className="text-white/60">
            Exibindo {products.length} produto(s) no filtro "{filter}"
            {products.length >= 100 && <span className="text-yellow-400 ml-2">(limite 100 - use filtros)</span>}
          </p>
        </div>
      </div>

      {/* FIX-WORKER-4 pass 13: filter UI funcional (state era morto sem UI) */}
      <div className="flex gap-2 mb-6 overflow-x-auto">
        {(['approved','qa_pending','qa_running','rejected','draft','archived','paused'] as const).map((s) => (
          <button key={s} onClick={() => setFilter(s)}
            aria-label={`Filtrar status ${s}`}
            aria-pressed={filter === s}
            className={`px-3 py-1.5 rounded-lg text-xs uppercase font-semibold whitespace-nowrap transition-colors ${
              filter === s
                ? 'bg-gradient-to-r from-magenta to-violet-deep text-white'
                : 'glass hover:border-white/30'
            }`}>
            {s}
          </button>
        ))}
      </div>

      {/* FIX-WORKER-4 pass 171 (a11y V8 R23): role=alert/status + type=button + aria-label */}
      {loadError && (
        <div role="alert" className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg mb-4 flex items-center justify-between">
          <span>Erro carregando lista: {loadError}</span>
          <button type="button" onClick={() => { setLoadError(''); load(); }}
            aria-label="Tentar carregar lista novamente"
            className="text-xs hover:underline focus-visible:outline-2 focus-visible:outline-red-400 rounded">retry</button>
        </div>
      )}

      {/* FIX-WORKER-4 pass 3: banners action via useAdminAction */}
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

      <div className="glass p-6 overflow-x-auto">
        {products.length === 0 ? (
          /* FIX-WORKER-4 pass 13: empty state condicional (era tabela vazia silenciosa) */
          <p className="text-white/60 text-center py-12">
            {loadError
              ? 'Nao foi possivel carregar produtos.'
              : `Nenhum produto com status "${filter}".`}
          </p>
        ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-white/40 uppercase border-b border-white/10">
            <tr>
              <th className="py-2">Produto</th><th>Vendedor</th><th>Categoria</th>
              <th>Preco</th><th>Vendas</th><th>Rating</th><th>Status</th><th className="text-right">Acoes</th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => {
              // FIX-WORKER-4 pass 13: per-row busy state (pattern consolidado)
              const busyTake = action.busyKey === `take-${p.id}`;
              const busyArchive = action.busyKey === `archive-${p.id}`;
              // Status real (era hardcoded "approved")
              const statusReal = p.status || filter;
              return (
              <tr key={p.id} className="border-b border-white/5 hover:bg-white/5">
                <td className="py-3">
                  <div className="flex items-center gap-3">
                    {/* FIX-WORKER-4 pass 13: <img> -> next/image (pattern W8/W3) */}
                    {p.cover_image_url ? (
                      <div className="w-12 h-12 relative rounded overflow-hidden flex-shrink-0">
                        <Image src={p.cover_image_url} alt={p.title || 'Produto'}
                          fill sizes="48px" className="object-cover" />
                      </div>
                    ) : (
                      <div className="w-12 h-12 bg-white/5 rounded flex-shrink-0" aria-hidden="true" />
                    )}
                    <div>
                      <div className="font-medium">{p.title}</div>
                      <div className="text-xs text-white/40 font-mono">{p.slug}</div>
                    </div>
                  </div>
                </td>
                <td>{p.is_platform_owned
                  ? <span className="px-2 py-0.5 rounded bg-magenta/20 text-magenta-glow text-xs flex items-center gap-1 w-fit"><Award className="w-3 h-3" aria-hidden="true" /> CAS Oficial</span>
                  : (p.store_name || '-')}
                </td>
                <td className="text-white/60">{p.category_name || '-'}</td>
                <td className="font-display font-bold text-magenta-glow">{fmtBRL(p.price_cents)}</td>
                <td className="font-mono text-xs">{p.sales_count || 0}</td>
                <td>{p.avg_rating ? Number(p.avg_rating).toFixed(1) : '-'}</td>
                {/* FIX-WORKER-4 pass 13: badge dinamico (era hardcoded "approved" verde) */}
                <td>
                  <span className={`px-2 py-0.5 rounded text-xs ${STATUS_COLOR[statusReal] || 'bg-white/10 text-white/60'}`}>
                    {statusReal}
                  </span>
                </td>
                <td className="text-right space-x-2">
                  {/* FIX-WORKER-4 pass 13: rel security pattern W4 pass 7 */}
                  <a href={`https://cas.inovareinteligenciaartificial.com/product/${p.slug}`}
                    target="_blank" rel="noopener noreferrer"
                    aria-label={`Abrir ${p.title} na vitrine`}
                    className="text-magenta hover:underline text-xs inline-flex items-center gap-1">
                    <ExternalLink className="w-3 h-3" aria-hidden="true" /> Ver
                  </a>
                  {!p.is_platform_owned && statusReal !== 'archived' && (
                    <button type="button" onClick={() => platformTake(p.id)}
                      disabled={busyTake || busyArchive}
                      aria-label={`Platform-take produto ${p.title}`}
                      className="text-yellow-400 hover:underline text-xs inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-wait focus-visible:outline-2 focus-visible:outline-yellow-400 rounded">
                      <Award className="w-3 h-3" aria-hidden="true" /> {busyTake ? '...' : 'Take'}
                    </button>
                  )}
                  {/* FIX-WORKER-4 pass 13: Arquivar so se nao ja arquivado */}
                  {statusReal !== 'archived' && (
                    <button type="button" onClick={() => archive(p.id)}
                      disabled={busyArchive || busyTake}
                      aria-label={`Arquivar produto ${p.title}`}
                      className="text-red-400 hover:underline text-xs inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-wait focus-visible:outline-2 focus-visible:outline-red-400 rounded">
                      <Archive className="w-3 h-3" aria-hidden="true" /> {busyArchive ? '...' : 'Arquivar'}
                    </button>
                  )}
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
