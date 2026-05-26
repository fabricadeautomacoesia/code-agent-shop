'use client';

import { useEffect, useState } from 'react';
import { adminFetch, fmtBRL, fmtDate } from '@/lib/admin-api';
import { Archive, Award, ExternalLink, Eye } from 'lucide-react';
import Link from 'next/link';

export default function AdminProductsPage() {
  const [products, setProducts] = useState<any[]>([]);
  const [filter, setFilter] = useState('approved');
  const [error, setError] = useState('');

  async function load() {
    try {
      const r = await adminFetch<{ results?: any[]; products?: any[] }>(
        `/search?limit=100${filter ? `&status=${filter}` : ''}`
      );
      setProducts(r.results || r.products || []);
    } catch (e: any) { setError(e.message); }
  }
  useEffect(() => { load(); }, [filter]);

  async function archive(id: string) {
    if (!confirm('Arquivar este produto?')) return;
    await adminFetch(`/products/admin/${id}/archive`, { method: 'POST' });
    load();
  }
  async function platformTake(id: string) {
    if (!confirm('Acionar Clausula Master? Vai criar copia 100% plataforma.')) return;
    const reason = prompt('Justificativa:');
    if (!reason) return;
    await adminFetch(`/products/admin/${id}/platform-take`, { method: 'POST', body: JSON.stringify({ reason }) });
    load();
  }

  return (
    <div>
      <div className="flex justify-between items-end mb-8">
        <div>
          <h1 className="font-display font-bold text-4xl mb-2">Produtos</h1>
          <p className="text-white/60">{products.length} produto(s) no catalogo</p>
        </div>
      </div>

      {error && <div className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg mb-4">{error}</div>}

      <div className="glass p-6 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-white/40 uppercase border-b border-white/10">
            <tr>
              <th className="py-2">Produto</th><th>Vendedor</th><th>Categoria</th>
              <th>Preco</th><th>Vendas</th><th>Rating</th><th>Status</th><th className="text-right">Acoes</th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.id} className="border-b border-white/5 hover:bg-white/5">
                <td className="py-3">
                  <div className="flex items-center gap-3">
                    {p.cover_image_url && (
                      <img src={p.cover_image_url} alt={p.title}
                        className="w-12 h-12 object-cover rounded" />
                    )}
                    <div>
                      <div className="font-medium">{p.title}</div>
                      <div className="text-xs text-white/40 font-mono">{p.slug}</div>
                    </div>
                  </div>
                </td>
                <td>{p.is_platform_owned
                  ? <span className="px-2 py-0.5 rounded bg-magenta/20 text-magenta-glow text-xs flex items-center gap-1 w-fit"><Award className="w-3 h-3" /> CAS Oficial</span>
                  : (p.store_name || '-')}
                </td>
                <td className="text-white/60">{p.category_name || '-'}</td>
                <td className="font-display font-bold text-magenta-glow">{fmtBRL(p.price_cents)}</td>
                <td className="font-mono text-xs">{p.sales_count || 0}</td>
                <td>{p.avg_rating ? Number(p.avg_rating).toFixed(1) : '-'}</td>
                <td>
                  <span className="px-2 py-0.5 rounded bg-green-500/20 text-green-400 text-xs">approved</span>
                </td>
                <td className="text-right space-x-2">
                  <a href={`https://cas.inovareinteligenciaartificial.com/product/${p.slug}`} target="_blank"
                    className="text-magenta hover:underline text-xs inline-flex items-center gap-1">
                    <ExternalLink className="w-3 h-3" /> Ver
                  </a>
                  {!p.is_platform_owned && (
                    <button onClick={() => platformTake(p.id)} className="text-yellow-400 hover:underline text-xs inline-flex items-center gap-1">
                      <Award className="w-3 h-3" /> Take
                    </button>
                  )}
                  <button onClick={() => archive(p.id)} className="text-red-400 hover:underline text-xs inline-flex items-center gap-1">
                    <Archive className="w-3 h-3" /> Arquivar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
