'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Send, Plus, AlertCircle, CheckCircle, Clock, FileEdit } from 'lucide-react';
import { sellerFetch, fmtBRL, fmtDate } from '@/lib/seller-api';
import { useSellerAction } from '@/lib/use-seller-action';

const STATUS_COLOR: Record<string, string> = {
  draft:        'bg-gray-500/20 text-gray-300',
  qa_pending:   'bg-blue-500/20 text-blue-400',
  qa_running:   'bg-blue-500/30 text-blue-300',
  approved:     'bg-green-500/20 text-green-400',
  rejected:     'bg-red-500/20 text-red-400',
  paused:       'bg-yellow-500/20 text-yellow-400',
  archived:     'bg-white/10 text-white/40',
};

export default function SellerProductsPage() {
  const [products, setProducts] = useState<any[]>([]);
  const [loadError, setLoadError] = useState('');
  const [filter, setFilter] = useState('all');

  async function load() {
    try { const r = await sellerFetch<{ products: any[] }>('/products/me'); setProducts(r.products); setLoadError(''); }
    catch (e: any) { setLoadError(e.message); }
  }
  useEffect(() => { load(); }, []);

  // FIX-WORKER-5 pass 1: useSellerAction hook substitui alert(e.message) browser-blocking.
  // Era UX feio + nao indicava success. Agora: 2 banners inline + busy state.
  const action = useSellerAction(load);

  async function submitQA(id: string) {
    const { confirmDialog } = await import('@/components/prompt-dialog');
    if (!await confirmDialog('Enviar para QA automatizado?', {
      body: 'O pipeline LLM avaliara seu produto. Confidence < 80% = rejeitado.',
      confirmLabel: 'Enviar para QA',
    })) return;
    action.run(`submit-${id}`, async () => {
      await sellerFetch(`/products/me/${id}/submit`, { method: 'POST' });
      return `Produto ${id.slice(0, 8)}... enviado para QA`;
    });
  }

  const filtered = filter === 'all' ? products : products.filter((p) => p.status === filter);

  return (
    <div>
      <div className="flex items-end justify-between mb-8">
        <div>
          <h1 className="font-display font-bold text-4xl mb-2">Meus produtos</h1>
          <p className="text-white/60">{products.length} produto(s) cadastrado(s)</p>
        </div>
        <Link href="/upload" className="btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" /> Novo produto
        </Link>
      </div>

      <div className="flex gap-2 mb-6 overflow-x-auto">
        {['all','draft','qa_pending','qa_running','approved','rejected','archived'].map((s) => (
          <button key={s} onClick={() => setFilter(s)}
            className={`px-3 py-1.5 rounded-lg text-xs uppercase font-semibold whitespace-nowrap ${
              filter === s ? 'bg-gradient-to-r from-magenta to-violet-deep text-white' : 'glass hover:border-white/30'
            }`}>
            {s === 'all' ? 'Todos' : s}
          </button>
        ))}
      </div>

      {loadError && <div className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg mb-4">Erro carregando lista: {loadError}</div>}

      {/* FIX-WORKER-5 pass 1 + 172 (a11y V8 R23) */}
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
        {filtered.length === 0 ? (
          <p className="text-white/60 text-center py-12">
            Nenhum produto neste filtro.{' '}
            <Link href="/upload" className="text-magenta hover:underline">Criar agora</Link>
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-white/40 uppercase border-b border-white/10">
              <tr><th className="py-2">Titulo</th><th>Status</th><th>QA Score</th><th>Preco</th><th>Vendas</th><th>Rating</th><th>Criado</th><th className="text-right">Acoes</th></tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr key={p.id} className="border-b border-white/5 hover:bg-white/5">
                  <td className="py-3">
                    <div className="font-medium">{p.title}</div>
                    <div className="text-xs text-white/40 font-mono">{p.slug}</div>
                  </td>
                  <td><span className={`px-2 py-0.5 rounded text-xs ${STATUS_COLOR[p.status]}`}>{p.status}</span></td>
                  <td>
                    {p.qa_confidence_score !== null && (
                      <span className={`font-mono text-xs ${p.qa_confidence_score >= 0.8 ? 'text-green-400' : 'text-red-400'}`}>
                        {(p.qa_confidence_score * 100).toFixed(1)}%
                      </span>
                    )}
                  </td>
                  <td className="font-display font-bold text-magenta-glow">{fmtBRL(p.price_cents)}</td>
                  <td className="font-mono text-xs">{p.sales_count || 0}</td>
                  <td>{p.avg_rating ? Number(p.avg_rating).toFixed(1) : '-'}</td>
                  <td className="text-xs text-white/40">{fmtDate(p.created_at)}</td>
                  <td className="text-right space-x-2">
                    {(p.status === 'draft' || p.status === 'rejected') && (
                      <>
                        <Link href={`/products/${p.id}`} className="text-magenta hover:underline text-xs inline-flex items-center gap-1">
                          <FileEdit className="w-3 h-3" /> Editar
                        </Link>
                        {/* FIX-WORKER-5 pass 172 (a11y V8 R23): type=button + aria-label */}
                        <button type="button" onClick={() => submitQA(p.id)} disabled={action.busyKey === `submit-${p.id}`}
                          aria-label={`Enviar ${p.title} para fila de QA`}
                          className="text-green-400 hover:underline text-xs inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-wait focus-visible:outline-2 focus-visible:outline-green-400 rounded">
                          <Send className="w-3 h-3" aria-hidden="true" /> {action.busyKey === `submit-${p.id}` ? 'Enviando...' : 'Enviar QA'}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
