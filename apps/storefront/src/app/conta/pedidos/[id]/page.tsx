'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { CheckCircle, Clock, Download, AlertCircle, Copy, Check } from 'lucide-react';
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
  /* FIX-WORKER-2 pass 518 (PIX copy UX paridade /checkout pass 488):
     PRE-FIX BUG: copy button sem try/catch + sem feedback visual
     - navigator.clipboard.writeText e ASYNC + pode throw:
       * Permission denied (iframe sem 'clipboard-write' permission)
       * Insecure context (HTTP em vez de HTTPS - dev local edge)
       * iOS Safari < 13 sem Clipboard API
       * User browser preference 'never allow'
     - Sem try/catch -> unhandled rejection silent
     - Sem feedback -> user clica icon Copy, nada acontece, silent fail
     - Cenario real:
       1. User completa checkout PIX desktop -> ve order detail
       2. Clica copy icon -> nada (silent fail OR sucesso silencioso)
       3. User pensa que copiou -> cola no app banco -> texto velho/vazio
       4. Pagamento incompleto = perda revenue + UX broken
     POST-FIX: paridade /checkout/page.tsx pass 488 copyPix function
     - pixCopied state + setTimeout 2.5s reset
     - Check icon visual feedback (green) durante copied state
     - try/catch fallback textarea.select() para legacy clients */
  const [pixCopied, setPixCopied] = useState(false);

  async function copyPix(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setPixCopied(true);
      setTimeout(() => setPixCopied(false), 2500);
    } catch {
      // Fallback iOS antigo / contexto inseguro - seleciona textarea
      const ta = document.querySelector<HTMLTextAreaElement>('textarea#pix-copy');
      if (ta) { ta.select(); ta.setSelectionRange(0, 99999); }
    }
  }

  useEffect(() => {
    if (!token) { router.push('/login'); return; }
    Api.api<any>(`/orders/${params.id}`, { auth: token, cache: 'no-store' })
      .then((r) => {
        setOrder(r.order);
        setItems(r.order?.items || []);
      })
      .catch((e) => setErr(e.message));
  }, [token, params.id]);

  if (err) return (
    /* FIX-WORKER-2 pass 238 (UX dead-end error): page mostrava "Erro: X" sem
       CTAs. User stuck - sem voltar, retry ou navegar. Comum: pedido de outro
       user (403), id inexistente (404), session expired pos-load (401).
       POST-FIX: role=alert + 2 CTAs (Voltar conta + Tentar novamente refresh).
       FIX-WORKER-2 pass 571 (a11y CTAs focus-visible - paridade cadeia 549/552):
       Adicionado focus-visible outline magenta em ambos CTAs (kbd nav). */
    <div className="container mx-auto px-6 py-16 max-w-md text-center">
      <div role="alert" className="glass p-6">
        <AlertCircle className="w-12 h-12 mx-auto mb-3 text-red-400" aria-hidden="true" />
        <h1 className="font-display font-bold text-xl mb-2 text-red-400">Erro ao carregar pedido</h1>
        <p className="text-sm text-white/70 mb-4">{err}</p>
        <div className="flex gap-2 justify-center">
          <Link href="/conta"
            className="btn-ghost text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-magenta">
            Voltar para conta
          </Link>
          <button type="button" onClick={() => { setErr(''); router.refresh(); }}
            className="btn-primary text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-magenta">
            Tentar novamente
          </button>
        </div>
      </div>
    </div>
  );
  if (!order) return (
    /* FIX-WORKER-2 pass 571 (a11y loading state - paridade pass 556 /conta/pedidos):
        role=status + aria-live polite p/ SR announce loading. */
    <div role="status" aria-live="polite"
      className="container mx-auto px-6 py-16 text-center text-white/60">
      Carregando...
    </div>
  );

  const badge = STATUS_BADGE[order.status] || STATUS_BADGE.cart;

  return (
    <div className="container mx-auto px-6 py-8 max-w-3xl">
      {/* FIX-WORKER-2 pass 571 (a11y - paridade pass 561 /sobre + pass 549 esqueci-senha):
          Top 'Voltar' link kbd focus-visible outline magenta. */}
      <Link href="/conta"
        className="text-sm text-white/60 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-magenta rounded">
        &larr; Voltar para conta
      </Link>

      {/* FIX-WORKER-15 pass 245 (mobile 375px overflow):
          Header tinha flex items-center justify-between sem flex-wrap. Em mobile
          375px com order_number longo "CAS-2026-001234" (~190px text-3xl) +
          status badge "Aguardando pagto" (~140px) + padding container 24px*2 =
          ~378px contra viewport 375px = overflow horizontal scroll.
          POST-FIX: flex-wrap + gap-3 + items-start (alinhar topo) + text-2xl
          sm:text-3xl (mobile menor) - same pattern do PDP (pass 4 product/[slug]). */}
      <div className="flex flex-wrap items-start justify-between gap-3 mt-4 mb-8">
        <div className="min-w-0 flex-1">
          <h1 className="font-display font-bold text-2xl sm:text-3xl break-words">Pedido {order.order_number}</h1>
          {/* FIX-WORKER-2 pass 316: usa Api.formatDate defensive helper */}
          <p className="text-white/60 text-sm">{Api.formatDate(order.created_at)}</p>
        </div>
        <span className={`px-3 py-1.5 rounded-lg text-sm font-semibold flex items-center gap-2 flex-shrink-0 ${badge.cls}`}>
          <badge.Icon className="w-4 h-4" aria-hidden="true" /> {badge.label}
        </span>
      </div>

      {/* PAGAMENTO PENDENTE */}
      {order.status === 'pending_payment' && (
        <div className="glass p-6 mb-6 border-l-4 border-yellow-500">
          {/* FIX-WORKER-2 pass 571 (a11y - paridade pass 541/561):
              Clock heading icon decorativo + 'Conclua o pagamento' descritivo. */}
          <h2 className="font-display font-bold text-xl mb-4 flex items-center gap-2">
            <Clock className="w-5 h-5 text-yellow-400" aria-hidden="true" /> Conclua o pagamento
          </h2>
          {order.payment_method === 'pix' && order.asaas_pix_qrcode && (
            <div className="text-center">
              {/* FIX pass 518: alt text descritivo (a11y paridade /checkout pass 488) */}
              <img src={`data:image/png;base64,${order.asaas_pix_qrcode}`}
                alt="QR Code para pagamento PIX" className="w-56 h-56 mx-auto bg-white p-2 rounded-lg mb-4" />
              {order.asaas_pix_copy_paste && (
                <div className="max-w-md mx-auto">
                  {/* FIX-WORKER-2 pass 163 (a11y): htmlFor + id + type=button + aria-label + autoComplete=off PII
                      FIX-WORKER-2 pass 518: copy button feedback paridade /checkout pass 488 */}
                  <label htmlFor="pix-copy" className="text-xs text-white/60 block mb-1 text-left">Copia e cola PIX</label>
                  <div className="flex gap-2">
                    <textarea id="pix-copy" readOnly value={order.asaas_pix_copy_paste}
                      autoComplete="off"
                      aria-describedby="pix-copy-help"
                      onFocus={(e) => e.target.select()}
                      className="flex-1 p-2 rounded bg-white/5 border border-white/10 text-xs font-mono" rows={3} />
                    <button type="button"
                      onClick={() => copyPix(order.asaas_pix_copy_paste || '')}
                      disabled={!order.asaas_pix_copy_paste}
                      aria-label={pixCopied ? 'Codigo PIX copiado' : 'Copiar codigo PIX para area de transferencia'}
                      className="p-2 hover:bg-white/5 rounded h-fit focus-visible:outline-2 focus-visible:outline-magenta disabled:opacity-40 inline-flex items-center gap-1 text-xs">
                      {pixCopied
                        ? <><Check className="w-4 h-4 text-green-400" aria-hidden="true" /> <span className="text-green-400">Copiado!</span></>
                        : <><Copy className="w-4 h-4" aria-hidden="true" /> <span>Copiar</span></>}
                    </button>
                  </div>
                  <span id="pix-copy-help" className="sr-only">Cole este codigo no app do banco para pagar via PIX</span>
                </div>
              )}
            </div>
          )}
          {/* FIX-WORKER-2 pass 268 (tabnabbing defense parity):
              Pass 230 W1 ja aplicou rel="noopener noreferrer" em notification-bell.
              2 instances aqui (boleto + credit_card external links) ficaram desatualizadas.
              Pattern V8: TODOS target="_blank" precisam rel=noopener noreferrer. */}
          {/* FIX-WORKER-2 pass 571 (a11y external CTAs focus-visible - paridade cadeia):
              Boleto + cartao Asaas external links sem focus-visible outline.
              Kbd users perdem affordance ao tabular. */}
          {order.payment_method === 'boleto' && order.asaas_boleto_url && (
            <a href={order.asaas_boleto_url} target="_blank" rel="noopener noreferrer"
              className="btn-primary block text-center max-w-md mx-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-magenta">
              Abrir boleto
            </a>
          )}
          {order.payment_method === 'credit_card' && order.asaas_invoice_url && (
            <a href={order.asaas_invoice_url} target="_blank" rel="noopener noreferrer"
              className="btn-primary block text-center max-w-md mx-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-magenta">
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
          {/* FIX-WORKER-2 pass 571 (a11y - CheckCircle heading icon aria-hidden) */}
          <h2 className="font-display font-bold text-xl mb-4 flex items-center gap-2">
            <CheckCircle className="w-5 h-5 text-green-400" aria-hidden="true" /> Pagamento confirmado
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
              {/* FIX-WORKER-8 pass 2: <img> -> next/image */}
              {it.snapshot?.cover_image_url && (
                <div className="w-16 h-16 relative rounded overflow-hidden flex-shrink-0">
                  <Image src={it.snapshot.cover_image_url} alt={it.snapshot?.title || 'Produto'}
                    fill sizes="64px" className="object-cover" />
                </div>
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

      {/* FIX-WORKER-2 pass 389 (link 404 + UX multi-item):
          PRE-FIX: Link href={`/product/${items[0]?.snapshot?.slug || ''}`}
          - Se slug vazio -> /product/ -> 404 PDP catch-all
          - Multi-item order: link so do PRIMEIRO item (UX confuso - qual produto?)
          - 'Ver produto na vitrine' singular sugere 1 produto mas order tem N
          POST-FIX:
          - Skip link se slug vazio (fallback hide)
          - Multi-item: cada item ja tem own actions na lista acima
          - Single-item: link contextual com nome do produto
          - Sempre link p/ catalogo /products como bottom fallback */}
      <div className="mt-6 text-center space-y-2">
        {items.length === 1 && items[0]?.snapshot?.slug && (
          <Link href={`/product/${items[0].snapshot.slug}`} className="text-sm text-white/60 hover:text-white block">
            Ver {items[0].snapshot?.title || 'produto'} na vitrine →
          </Link>
        )}
        <Link href="/products" className="text-sm text-white/40 hover:text-white block">
          Explorar mais produtos no catalogo
        </Link>
      </div>
    </div>
  );
}
