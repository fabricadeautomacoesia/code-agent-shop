'use client';

import { useEffect, useState } from 'react';
import { adminFetch, fmtBRL, fmtDate } from '@/lib/admin-api';
import { TrendingUp, ShoppingBag, Clock } from 'lucide-react';

const STATUS_COLOR: Record<string, string> = {
  cart:            'bg-gray-500/20 text-gray-300',
  pending_payment: 'bg-yellow-500/20 text-yellow-400',
  paid:            'bg-green-500/20 text-green-400',
  fulfilled:       'bg-green-600/20 text-green-300',
  disputed:        'bg-orange-500/20 text-orange-400',
  refunded:        'bg-red-500/20 text-red-400',
  cancelled:       'bg-white/10 text-white/40',
  expired:         'bg-white/10 text-white/40',
};

export default function AdminOrdersPage() {
  const [orders, setOrders] = useState<any[]>([]);
  const [stats, setStats] = useState<any>({ count_paid: 0, count_pending: 0, total_revenue: 0 });
  const [error, setError] = useState('');
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  async function load() {
    try {
      const r = await adminFetch<{ orders: any[]; stats: any }>('/orders/admin/recent');
      setOrders(r.orders || []);
      setStats(r.stats || stats);
      // FIX-WORKER-4 pass 6: limpa erro em sucesso (era persistente)
      setError('');
      setLastUpdate(new Date());
    } catch (e: any) { setError(e.message); }
  }
  // FIX-WORKER-4 pass 6: poll inteligente - pausa quando tab background.
  // Antes: setInterval(30s) rodava sempre, mesmo com tab offscreen.
  // 5 tabs admin abertos = 10 calls/min mesmo invisivel ao admin.
  // Agora: document.hidden suspende, visibilitychange retoma + faz fetch imediato.
  useEffect(() => {
    load();
    let i: NodeJS.Timeout | null = setInterval(load, 30000);
    const onVisChange = () => {
      if (document.hidden) {
        if (i) { clearInterval(i); i = null; }
      } else {
        if (!i) {
          load(); // refresh imediato ao voltar a foco
          i = setInterval(load, 30000);
        }
      }
    };
    document.addEventListener('visibilitychange', onVisChange);
    return () => {
      if (i) clearInterval(i);
      document.removeEventListener('visibilitychange', onVisChange);
    };
  }, []);

  return (
    <div>
      <h1 className="font-display font-bold text-4xl mb-2">Pedidos</h1>
      <div className="flex items-center justify-between mb-8">
        <p className="text-white/60">Auditoria de pedidos da plataforma - refresh 30s (pausa em background)</p>
        {/* FIX-WORKER-4 pass 6: indicador de ultima sync para admin saber freshness */}
        {lastUpdate && (
          <p className="text-xs text-white/40">
            Atualizado: {lastUpdate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </p>
        )}
      </div>

      {/* FIX-WORKER-4 pass 171 (a11y V8 R23): role=alert + type=button + aria-label */}
      {error && (
        <div role="alert" className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg mb-4 flex items-center justify-between">
          <span>Erro carregando pedidos: {error}</span>
          <button type="button" onClick={() => { setError(''); load(); }}
            aria-label="Tentar carregar pedidos novamente"
            className="text-xs hover:underline focus-visible:outline-2 focus-visible:outline-red-400 rounded">retry</button>
        </div>
      )}

      {/* FIX-WORKER-4 pass 253 (defensive Number cast + aria-hidden icons):
          Stats null/undefined em backend transient state -> renderia "undefined"
          ou "null" literal em cards de admin (uglyUX + percepcao de bug).
          Total revenue ja tinha || 0 fallback; counts NAO. Pattern V8 defensive
          render: Number() cast com fallback 0 em todos numericos.
          Tambem aria-hidden em icons decorativos (Star/ShoppingBag/Clock pattern). */}
      <div className="grid md:grid-cols-3 gap-4 mb-8">
        <div className="glass p-5">
          <div className="stat-label flex items-center gap-2"><ShoppingBag className="w-3 h-3" aria-hidden="true" /> Pedidos pagos</div>
          <div className="stat-value text-green-400">{Number(stats.count_paid) || 0}</div>
        </div>
        <div className="glass p-5">
          <div className="stat-label flex items-center gap-2"><Clock className="w-3 h-3" aria-hidden="true" /> Pendentes</div>
          <div className="stat-value text-yellow-400">{Number(stats.count_pending) || 0}</div>
        </div>
        <div className="glass p-5">
          <div className="stat-label flex items-center gap-2"><TrendingUp className="w-3 h-3" aria-hidden="true" /> Receita total</div>
          <div className="stat-value">{fmtBRL(stats.total_revenue || 0)}</div>
        </div>
      </div>

      <div className="glass p-6 overflow-x-auto">
        <h2 className="font-display font-bold text-xl mb-4">Pedidos recentes ({orders.length})</h2>
        {orders.length === 0 ? (
          <p className="text-white/60 text-center py-12">
            Ainda nao ha pedidos. Quando comecarem a vender, eles aparecerao aqui.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-white/40 uppercase border-b border-white/10">
              <tr>
                <th className="py-2">Pedido</th><th>Comprador</th><th>Valor</th>
                <th>Pagamento</th><th>Status</th><th>Criado em</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className="border-b border-white/5 hover:bg-white/5">
                  <td className="py-3 font-mono text-xs">{o.order_number}</td>
                  <td>
                    <div>{o.buyer_name || '-'}</div>
                    <div className="text-xs text-white/40">{o.buyer_email}</div>
                  </td>
                  <td className="font-display font-bold text-magenta-glow">{fmtBRL(o.total_cents)}</td>
                  <td className="text-xs">
                    <span className="px-1.5 py-0.5 rounded bg-white/5">{o.payment_method}</span>
                    <span className="text-white/50 ml-1">{o.payment_status}</span>
                  </td>
                  {/* FIX-WORKER-4 pass 6: fallback default p/ status inesperado (ex: backend adicionar 'chargeback') */}
                  <td><span className={`px-2 py-0.5 rounded text-xs ${STATUS_COLOR[o.status] || 'bg-white/10 text-white/60'}`}>{o.status}</span></td>
                  <td className="text-xs text-white/40">{fmtDate(o.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
