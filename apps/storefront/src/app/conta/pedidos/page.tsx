'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
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
  // FIX-WORKER-2 pass 428 (silent failure UX bug):
  //   PRE-FIX: Api.api(...).then(setOrders).finally(setLoading) sem .catch()
  //   - Gateway 502 / 401 expired / network offline -> orders fica []
  //   - UI mostra "Voce ainda nao fez nenhum pedido" (FALSE NEGATIVE)
  //   - User com 50 pedidos historicos ve tela vazia = panico
  //   - Sem retry button = F5 manual
  //   - Console.error silent (catch missing) = SR nao anuncia
  //   POST-FIX:
  //   - + error state + load() helper
  //   - 401 -> redirect /login (token expirou pos-render)
  //   - Outros erros -> banner role=alert + retry button
  //   - Pattern paridade dashboard-admin pass 427 (loadError + retry)
  const [error, setError] = useState('');

  function load() {
    if (!token) { router.push('/login'); return; }
    setLoading(true); setError('');
    Api.api<{ orders: any[] }>('/orders', { auth: token, cache: 'no-store' })
      .then((r) => setOrders(r.orders || []))
      .catch((e: any) => {
        // 401: token expirou - redirect login (em vez de mostrar erro misto)
        if (e?.status === 401) { router.push('/login?next=/conta/pedidos'); return; }
        setError(e?.message || 'Erro ao carregar pedidos. Tente novamente.');
      })
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); }, [token]);

  return (
    <div className="container mx-auto px-6 py-8 max-w-4xl">
      <Link href="/conta" className="text-sm text-white/60 hover:text-white">&larr; Voltar para conta</Link>
      <h1 className="font-display font-bold text-4xl mt-4 mb-2">Meus pedidos</h1>
      <p className="text-white/60 mb-8">{orders.length} pedido(s) no historico</p>

      {/* FIX-WORKER-2 pass 428: error banner role=alert + retry (paridade W4 pass 427)
          Distingue erro real de lista vazia - antes a colisao causava FALSE NEGATIVE
          ("voce ainda nao fez nenhum pedido" quando havia 50 historicos). */}
      {error && (
        <div role="alert" className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg mb-4 flex items-center justify-between">
          <span>{error}</span>
          <button type="button" onClick={load}
            aria-label="Tentar carregar pedidos novamente"
            className="text-xs hover:underline focus-visible:outline-2 focus-visible:outline-red-400 rounded">retry</button>
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-white/60">Carregando...</div>
      ) : error ? null : orders.length === 0 ? (
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
                {/* FIX-WORKER-8 pass 2: <img> stack -> next/image stack */}
                <div className="flex gap-2 -space-x-3">
                  {o.items_preview?.slice(0, 3).map((it: any, i: number) => (
                    it.cover && (
                      <div key={i} className="w-12 h-12 relative rounded border-2 border-cyber-dark overflow-hidden flex-shrink-0">
                        <Image src={it.cover} alt={it.title || 'Item do pedido'}
                          fill sizes="48px" className="object-cover" />
                      </div>
                    )
                  ))}
                </div>
                <div className="flex-1">
                  <div className="font-mono text-sm text-magenta">{o.order_number}</div>
                  {/* FIX-WORKER-2 pass 317: Api.formatDate defensive guard paridade pass 316
                      created_at null/invalid -> '-' (vs 'Invalid Date'). paid_at sempre tem
                      guard interno (truthy check + isNaN). */}
                  <div className="text-xs text-white/50">
                    {Api.formatDate(o.created_at, { day: '2-digit', month: 'short', year: 'numeric' })}
                    {o.paid_at && ` - pago em ${Api.formatDate(o.paid_at, { dateStyle: 'short' })}`}
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
