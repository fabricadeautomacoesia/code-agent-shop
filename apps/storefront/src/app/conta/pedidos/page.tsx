'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Package, ArrowRight, Clock, CheckCircle, AlertCircle } from 'lucide-react';
import { Api } from '@/lib/api';
import { useAuth } from '@/lib/store';

const STATUS_BADGE: Record<string, { label: string; cls: string; Icon: any }> = {
  cart:            { label: 'Carrinho',         cls: 'text-gray-400',     Icon: Clock },
  pending_payment: { label: 'Aguardando pagto', cls: 'text-yellow-400',   Icon: Clock },
  paid:            { label: 'Pago',             cls: 'text-green-400',    Icon: CheckCircle },
  fulfilled:       { label: 'Entregue',         cls: 'text-green-300',    Icon: CheckCircle },
  disputed:        { label: 'Em disputa',       cls: 'text-orange-400',   Icon: AlertCircle },
  refunded:        { label: 'Reembolsado',      cls: 'text-red-400',      Icon: AlertCircle },
  cancelled:       { label: 'Cancelado',        cls: 'text-white/40',     Icon: AlertCircle },
  expired:         { label: 'Expirado',         cls: 'text-white/40',     Icon: AlertCircle },
};

export default function PedidosPage() {
  const router = useRouter();
  const { token } = useAuth();
  const [orders, setOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) { router.push('/login'); return; }
    Api.api<{ orders: any[] }>('/orders', { auth: token, cache: 'no-store' })
      .then((r) => setOrders(r.orders || []))
      .finally(() => setLoading(false));
  }, [token]);

  return (
    <div className="container mx-auto px-6 py-8 max-w-4xl">
      <Link href="/conta" className="text-sm text-white/60 hover:text-white">&larr; Voltar para conta</Link>
      <h1 className="font-display font-bold text-4xl mt-4 mb-2">Meus pedidos</h1>
      <p className="text-white/60 mb-8">{orders.length} pedido(s) no historico</p>

      {loading ? (
        <div className="text-center py-12 text-white/60">Carregando...</div>
      ) : orders.length === 0 ? (
        <div className="glass p-12 text-center">
          <Package className="w-16 h-16 mx-auto mb-4 text-white/30" />
          <p className="text-xl mb-4">Voce ainda nao fez nenhum pedido</p>
          <Link href="/products" className="btn-primary inline-flex items-center gap-2">
            Explorar catalogo <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {orders.map((o) => {
            const b = STATUS_BADGE[o.status] || STATUS_BADGE.cart;
            return (
              <Link key={o.id} href={`/conta/pedidos/${o.id}`} className="glass p-4 hover:border-magenta transition-colors flex items-center gap-4 group">
                <div className="flex gap-2 -space-x-3">
                  {o.items_preview?.slice(0, 3).map((it: any, i: number) => (
                    it.cover && (
                      <img key={i} src={it.cover} className="w-12 h-12 object-cover rounded border-2 border-cyber-dark" alt="" />
                    )
                  ))}
                </div>
                <div className="flex-1">
                  <div className="font-mono text-sm text-magenta">{o.order_number}</div>
                  <div className="text-xs text-white/50">
                    {new Date(o.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })}
                    {o.paid_at && ` - pago em ${new Date(o.paid_at).toLocaleDateString('pt-BR')}`}
                  </div>
                  <div className="text-sm text-white/70 mt-1 line-clamp-1">
                    {o.items_preview?.map((it: any) => it.title).filter(Boolean).join(', ')}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-display font-bold text-lg">{Api.formatBRL(o.total_cents)}</div>
                  <div className={`text-xs flex items-center gap-1 justify-end ${b.cls}`}>
                    <b.Icon className="w-3 h-3" /> {b.label}
                  </div>
                </div>
                <ArrowRight className="w-5 h-5 text-white/30 group-hover:text-magenta transition-colors" />
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
