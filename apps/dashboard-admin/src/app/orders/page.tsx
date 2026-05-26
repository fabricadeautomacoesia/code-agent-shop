'use client';

import { useEffect, useState } from 'react';
import { adminFetch, fmtBRL, fmtDate } from '@/lib/admin-api';

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
  const [stats, setStats] = useState<any>({ total_revenue: 0, count_paid: 0, count_pending: 0 });

  useEffect(() => {
    adminFetch<{ orders: any[] }>('/orders/admin/recent').then((r) => setOrders(r.orders || [])).catch(() => {});
    // tenta tambem alguns endpoints alternativos
    adminFetch<any>('/aiops/status').then((r) => {
      // re-usa /api/status para feedback de saude
      setStats((s: any) => ({ ...s, uptime: r.uptime_s }));
    }).catch(() => {});
  }, []);

  return (
    <div>
      <h1 className="font-display font-bold text-4xl mb-2">Pedidos</h1>
      <p className="text-white/60 mb-8">Auditoria de pedidos da plataforma</p>

      <div className="grid md:grid-cols-3 gap-4 mb-8">
        <div className="glass p-5">
          <div className="text-xs text-white/50 uppercase mb-1">Pedidos pagos</div>
          <div className="font-display font-bold text-3xl text-green-400">{stats.count_paid}</div>
        </div>
        <div className="glass p-5">
          <div className="text-xs text-white/50 uppercase mb-1">Pendentes</div>
          <div className="font-display font-bold text-3xl text-yellow-400">{stats.count_pending}</div>
        </div>
        <div className="glass p-5">
          <div className="text-xs text-white/50 uppercase mb-1">Receita total</div>
          <div className="font-display font-bold text-3xl text-magenta-glow">{fmtBRL(stats.total_revenue || 0)}</div>
        </div>
      </div>

      <div className="glass p-6 overflow-x-auto">
        {orders.length === 0 ? (
          <p className="text-white/60 text-center py-12">
            Ainda nao ha pedidos. Quando vendedores comecarem a vender, eles aparecerao aqui.
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
                  <td>{o.buyer_email || o.buyer_user_id?.slice(0, 8)}</td>
                  <td className="font-display font-bold text-magenta-glow">{fmtBRL(o.total_cents)}</td>
                  <td className="text-xs">
                    {o.payment_method} <span className="text-white/50">/ {o.payment_status}</span>
                  </td>
                  <td><span className={`px-2 py-0.5 rounded text-xs ${STATUS_COLOR[o.status]}`}>{o.status}</span></td>
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
