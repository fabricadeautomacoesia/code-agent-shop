'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { CheckCircle, Clock, Download, AlertCircle, Copy } from 'lucide-react';
import { Api } from '@/lib/api';
import { useAuth } from '@/lib/store';
import { ReviewForm } from '@/components/review-form';

const STATUS_BADGE: Record<string, { label: string; cls: string; Icon: any }> = {
  cart:            { label: 'Carrinho',         cls: 'bg-gray-500/20 text-gray-300',     Icon: Clock },
  pending_payment: { label: 'Aguardando pagto', cls: 'bg-yellow-500/20 text-yellow-400', Icon: Clock },
  paid:            { label: 'Pago',             cls: 'bg-green-500/20 text-green-400',   Icon: CheckCircle },
  fulfilled:       { label: 'Entregue',         cls: 'bg-green-600/20 text-green-300',   Icon: CheckCircle },
  disputed:        { label: 'Em disputa',       cls: 'bg-orange-500/20 text-orange-400', Icon: AlertCircle },
  refunded:        { label: 'Reembolsado',      cls: 'bg-red-500/20 text-red-400',       Icon: AlertCircle },
  cancelled:       { label: 'Cancelado',        cls: 'bg-white/10 text-white/40',        Icon: AlertCircle },
  expired:         { label: 'Expirado',         cls: 'bg-white/10 text-white/40',        Icon: AlertCircle },
};

export default function PedidoPage() {
  const router = useRouter();
  const params = useParams();
  const { token } = useAuth();
  const [order, setOrder] = useState<any>(null);
  const [items, setItems] = useState<any[]>([]);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!token) { router.push('/login'); return; }
    Api.api<any>(`/orders/${params.id}`, { auth: token, cache: 'no-store' })
      .then((r) => {
        setOrder(r.order);
        setItems(r.order?.items || []);
      })
      .catch((e) => setErr(e.message));
  }, [token, params.id]);

  if (err) return <div className="container mx-auto px-6 py-16 text-center text-red-400">Erro: {err}</div>;
  if (!order) return <div className="container mx-auto px-6 py-16 text-center text-white/60">Carregando...</div>;

  const badge = STATUS_BADGE[order.status] || STATUS_BADGE.cart;

  return (
    <div className="container mx-auto px-6 py-8 max-w-3xl">
      <Link href="/conta" className="text-sm text-white/60 hover:text-white">&larr; Voltar para conta</Link>

      <div className="flex items-center justify-between mt-4 mb-8">
        <div>
          <h1 className="font-display font-bold text-3xl">Pedido {order.order_number}</h1>
          <p className="text-white/60 text-sm">{new Date(order.created_at).toLocaleString('pt-BR')}</p>
        </div>
        <span className={`px-3 py-1.5 rounded-lg text-sm font-semibold flex items-center gap-2 ${badge.cls}`}>
          <badge.Icon className="w-4 h-4" /> {badge.label}
        </span>
      </div>

      {/* PAGAMENTO PENDENTE */}
      {order.status === 'pending_payment' && (
        <div className="glass p-6 mb-6 border-l-4 border-yellow-500">
          <h2 className="font-display font-bold text-xl mb-4 flex items-center gap-2">
            <Clock className="w-5 h-5 text-yellow-400" /> Conclua o pagamento
          </h2>
          {order.payment_method === 'pix' && order.asaas_pix_qrcode && (
            <div className="text-center">
              <img src={`data:image/png;base64,${order.asaas_pix_qrcode}`} alt="PIX" className="w-56 h-56 mx-auto bg-white p-2 rounded-lg mb-4" />
              {order.asaas_pix_copy_paste && (
                <div className="max-w-md mx-auto">
                  <label className="text-xs text-white/60 block mb-1 text-left">Copia e cola PIX</label>
                  <div className="flex gap-2">
                    <textarea readOnly value={order.asaas_pix_copy_paste}
                      className="flex-1 p-2 rounded bg-white/5 border border-white/10 text-xs font-mono" rows={3} />
                    <button onClick={() => navigator.clipboard.writeText(order.asaas_pix_copy_paste)}
                      className="p-2 hover:bg-white/5 rounded h-fit">
                      <Copy className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          {order.payment_method === 'boleto' && order.asaas_boleto_url && (
            <a href={order.asaas_boleto_url} target="_blank" className="btn-primary block text-center max-w-md mx-auto">
              Abrir boleto
            </a>
          )}
          {order.payment_method === 'credit_card' && order.asaas_invoice_url && (
            <a href={order.asaas_invoice_url} target="_blank" className="btn-primary block text-center max-w-md mx-auto">
              Pagar com cartao
            </a>
          )}
          {!order.asaas_payment_id && (
            <div className="text-sm text-white/60 bg-orange-500/10 border border-orange-500/30 rounded p-3 mt-4">
              Cobranca Asaas nao gerada (configure ASAAS_API_KEY no servidor).
            </div>
          )}
        </div>
      )}

      {/* PAGO/ENTREGUE - DOWNLOADS */}
      {(order.status === 'paid' || order.status === 'fulfilled') && (
        <div className="glass p-6 mb-6 border-l-4 border-green-500">
          <h2 className="font-display font-bold text-xl mb-4 flex items-center gap-2">
            <CheckCircle className="w-5 h-5 text-green-400" /> Pagamento confirmado
          </h2>
          <p className="text-sm text-white/70">Seus produtos estao disponiveis para download abaixo.</p>
        </div>
      )}

      {/* ITEMS DO PEDIDO */}
      <div className="glass p-6">
        <h3 className="font-display font-bold text-xl mb-4">Itens do pedido</h3>
        <div className="space-y-3">
          {items.map((it) => (
            <div key={it.id} className="flex items-start gap-4 p-3 rounded-lg bg-white/5">
              {it.snapshot?.cover_image_url && (
                <img src={it.snapshot.cover_image_url} alt="" className="w-16 h-16 object-cover rounded" />
              )}
              <div className="flex-1">
                <div className="font-display font-semibold">{it.snapshot?.title || 'Produto'}</div>
                <div className="text-xs text-white/50 mt-1">Quantidade: {it.quantity}</div>
                {it.license_key && (order.status === 'paid' || order.status === 'fulfilled') && (
                  <div className="mt-2">
                    <label className="text-xs text-white/60">License key</label>
                    <code className="block bg-black/30 px-3 py-2 rounded font-mono text-xs mt-1">{it.license_key}</code>
                  </div>
                )}
              </div>
              <div className="text-right">
                <div className="font-display font-bold text-magenta-glow">{Api.formatBRL(it.line_total_cents)}</div>
                {it.download_token && (order.status === 'paid' || order.status === 'fulfilled') && (
                  <Link href={`/conta/downloads/${it.download_token}`}
                    className="btn-primary text-xs mt-2 inline-flex items-center gap-1">
                    <Download className="w-3 h-3" /> Baixar
                  </Link>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="border-t border-white/10 mt-6 pt-4 space-y-2 text-sm">
          <div className="flex justify-between"><span className="text-white/60">Subtotal</span><span>{Api.formatBRL(order.subtotal_cents)}</span></div>
          {order.discount_cents > 0 && (
            <div className="flex justify-between text-green-400"><span>Desconto {order.coupon_code && `(${order.coupon_code})`}</span><span>- {Api.formatBRL(order.discount_cents)}</span></div>
          )}
          <div className="flex justify-between text-xl font-display font-bold pt-2 border-t border-white/10">
            <span>Total</span>
            <span className="text-magenta-glow">{Api.formatBRL(order.total_cents)}</span>
          </div>
        </div>
      </div>

      {/* FORM DE REVIEW POR ITEM (so se pago) */}
      {(order.status === 'paid' || order.status === 'fulfilled') && items.length > 0 && (
        <div className="mt-6 space-y-4">
          <h2 className="font-display font-bold text-2xl">Avalie os produtos</h2>
          {items.map((it) => (
            <ReviewForm
              key={it.id}
              productId={it.product_id}
              orderId={order.id}
              productTitle={it.snapshot?.title || 'Produto'}
            />
          ))}
        </div>
      )}

      <div className="mt-6 text-center">
        <Link href={`/product/${items[0]?.snapshot?.slug || ''}`} className="text-sm text-white/60 hover:text-white">
          Ver produto na vitrine
        </Link>
      </div>
    </div>
  );
}
