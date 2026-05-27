'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Api } from '@/lib/api';
import { useAuth } from '@/lib/store';

type PaymentMethod = 'pix' | 'credit_card' | 'boleto';

export default function CheckoutPage() {
  const router = useRouter();
  const { token } = useAuth();
  const [cart, setCart] = useState<any>(null);
  const [method, setMethod] = useState<PaymentMethod>('pix');
  const [paymentResult, setPaymentResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [installments, setInstallments] = useState<any[]>([]);
  const [installmentCount, setInstallmentCount] = useState<number>(1);
  // FIX-WORKER-2 pass 4: verificacao CPF/CNPJ ANTES do pay click (preventive UX).
  // Sem CPF: payment-svc W11 pass 4 retorna 400 missing_cpf_cnpj. Em vez de
  // user clicar pay e levar erro, mostramos banner upfront direcionando para /conta.
  const [hasCpf, setHasCpf] = useState<boolean | null>(null); // null = loading

  useEffect(() => {
    if (!token) { router.push('/login'); return; }
    Api.cart(token).then((r) => setCart(r.cart)).catch(() => {});
    Api.me(token).then((r: any) => {
      const cpf = r.user?.cpf_cnpj || '';
      setHasCpf(cpf.replace(/\D/g, '').length >= 11);
    }).catch(() => setHasCpf(true)); // erro: deixa user tentar (fail-open client)
  }, [token]);

  // MLB-5: ao mudar para credit_card, busca preview de parcelas
  useEffect(() => {
    if (method !== 'credit_card' || !cart?.total_cents) { setInstallments([]); return; }
    Api.api<any>(`/payments/installments/preview?amount_cents=${cart.total_cents}`, { cache: 'no-store' })
      .then((r: any) => { setInstallments(r.installments || []); setInstallmentCount(1); })
      .catch(() => setInstallments([]));
  }, [method, cart?.total_cents]);

  async function pay() {
    setLoading(true); setErr('');
    try {
      const order: any = await Api.checkout(token!, method, method === 'credit_card' ? installmentCount : undefined);
      // FIX-WORKER-2 pass 2: payment-svc cria Asaas via setImmediate no backend (async).
      // Antes: 1 GET imediato -> asaas_pix_qrcode=null, UI mostra "Pedido criado!" sem QR.
      // Agora: poll com backoff 500ms..3s, 8 tentativas (~14s timeout) ate receber payment.
      // Boleto/invoice tem mesma logica (campos diferentes por metodo).
      const isReady = (o: any) => {
        if (method === 'pix') return !!o.asaas_pix_qrcode;
        if (method === 'credit_card') return !!o.asaas_invoice_url;
        if (method === 'boleto') return !!o.asaas_boleto_url;
        return !!o.asaas_payment_id;
      };
      let polled: any = null;
      const delays = [500, 800, 1200, 1800, 2400, 3000, 3000, 3000];
      for (const d of delays) {
        await new Promise((r) => setTimeout(r, d));
        const r: any = await Api.api(`/orders/${order.order.id}`, { auth: token!, cache: 'no-store' });
        polled = r.order;
        if (isReady(polled)) break;
      }
      if (!isReady(polled)) {
        setErr('Pagamento esta demorando mais do que o esperado. Veja em "Meus pedidos" - o pagamento sera atualizado em segundos.');
      }
      setPaymentResult({ order: order.order, asaas: polled });
    } catch (e: any) {
      setErr(e.data?.message || e.message);
    } finally { setLoading(false); }
  }

  if (paymentResult) {
    const o = paymentResult.asaas || paymentResult.order;
    return (
      <div className="container mx-auto px-6 py-16 max-w-2xl">
        <div className="glass p-8">
          <h1 className="font-display font-bold text-3xl mb-2">Pedido {o.order_number} criado!</h1>
          <p className="text-white/60 mb-6">Conclua o pagamento abaixo:</p>

          {/* FIX-WORKER-2 pass 2: fallback se Asaas demorou (raro mas possivel) */}
          {!o.asaas_payment_id && (
            <div className="p-4 rounded-lg bg-orange-500/10 border border-orange-500/30 mb-4">
              <p className="text-sm text-orange-200">
                Estamos preparando seu pagamento. Aguarde alguns segundos e atualize a pagina de <Link href={`/conta/pedidos/${o.id}`} className="underline">Meus pedidos</Link>.
              </p>
            </div>
          )}

          {method === 'pix' && o.asaas_pix_qrcode && (
            <div className="space-y-4">
              <img src={`data:image/png;base64,${o.asaas_pix_qrcode}`} alt="PIX QR Code" className="w-64 h-64 mx-auto bg-white p-2 rounded-lg" />
              <div>
                <label className="text-sm text-white/70 block mb-1">Codigo PIX Copia e Cola</label>
                <textarea readOnly value={o.asaas_pix_copy_paste || ''}
                  className="w-full p-3 rounded-lg bg-white/5 border border-white/10 text-xs font-mono" rows={4} />
              </div>
            </div>
          )}
          {method === 'boleto' && o.asaas_boleto_url && (
            <a href={o.asaas_boleto_url} target="_blank" className="btn-primary block text-center">Abrir boleto</a>
          )}
          {method === 'credit_card' && o.asaas_invoice_url && (
            <a href={o.asaas_invoice_url} target="_blank" className="btn-primary block text-center">Pagar com cartao</a>
          )}

          <div className="mt-8 pt-6 border-t border-white/10 text-sm text-white/60">
            Apos confirmacao do pagamento (via webhook Asaas), seus produtos ficarao disponiveis em{' '}
            <Link href="/conta/pedidos" className="text-magenta hover:underline">Meus pedidos</Link>.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-6 py-8 max-w-3xl">
      <h1 className="font-display font-bold text-4xl mb-8">Checkout</h1>

      {cart && (
        <div className="glass p-6 mb-6">
          <h3 className="font-display font-bold text-lg mb-4">Resumo do pedido</h3>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-white/60">{cart.items_count} item(s)</span><span>{Api.formatBRL(cart.subtotal_cents)}</span></div>
            {cart.discount_cents > 0 && <div className="flex justify-between text-green-400"><span>Desconto</span><span>- {Api.formatBRL(cart.discount_cents)}</span></div>}
            <div className="flex justify-between text-xl font-display font-bold pt-2 border-t border-white/10 mt-2">
              <span>Total</span>
              <span className="text-magenta-glow">{Api.formatBRL(cart.total_cents)}</span>
            </div>
          </div>
        </div>
      )}

      <div className="glass p-6 mb-6">
        <h3 className="font-display font-bold text-lg mb-4">Forma de pagamento</h3>
        {/* FIX-WORKER-15: mobile-first - 1 col em 375px, 3 cols sm:+
            Antes: grid-cols-3 sempre -> textos cortados/quebrados em 375px (Pixel 5/iPhone SE) */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {(['pix','credit_card','boleto'] as PaymentMethod[]).map((m) => (
            <button key={m} onClick={() => setMethod(m)}
              className={`p-4 rounded-lg border-2 text-left sm:text-center transition-all ${method === m ? 'border-magenta bg-magenta/10' : 'border-white/10 bg-white/5 hover:border-white/30'}`}>
              <div className="font-display font-semibold capitalize">{m.replace('_', ' ')}</div>
              <div className="text-xs text-white/50 mt-1">
                {m==='pix' && 'Aprovacao instantanea'}
                {m==='credit_card' && 'Parcelamento ate 12x'}
                {m==='boleto' && 'Vencimento 24h'}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* MLB-5: Mercado Credito - seletor de parcelas */}
      {method === 'credit_card' && installments.length > 0 && (
        <div className="glass p-6 mb-6">
          <h3 className="font-display font-bold text-lg mb-1">Parcelar em quantas vezes?</h3>
          <p className="text-xs text-white/50 mb-4">Ate 3x sem juros - 4x a 12x com juros de 2,99% a.m.</p>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2 max-h-72 overflow-y-auto pr-1">
            {installments.map((p) => (
              <button key={p.count} onClick={() => setInstallmentCount(p.count)}
                className={`p-3 rounded-lg border-2 text-left transition-all ${installmentCount === p.count ? 'border-magenta bg-magenta/10' : 'border-white/10 bg-white/5 hover:border-white/30'}`}>
                <div className="font-display font-semibold text-sm">{p.count}x</div>
                <div className="text-xs text-white/70">{Api.formatBRL(p.per_cents)}/mes</div>
                <div className={`text-[10px] mt-1 ${p.interest_pct > 0 ? 'text-orange-300' : 'text-green-400'}`}>
                  {p.interest_pct > 0 ? `+${p.interest_pct.toFixed(1)}% juros` : 'sem juros'}
                </div>
                {p.interest_pct > 0 && (
                  <div className="text-[10px] text-white/40 mt-0.5">Total {Api.formatBRL(p.total_cents)}</div>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* FIX-WORKER-2 pass 4: prompt cadastro incompleto ANTES do pay (preventive UX).
          Banner amarelo + link para /conta + desabilita botao se sem CPF. */}
      {hasCpf === false && (
        <div className="mb-4 p-4 rounded-lg bg-yellow-500/10 border border-yellow-500/30 text-sm">
          <div className="font-semibold text-yellow-300 mb-1">Cadastro incompleto</div>
          <div className="text-white/80">
            CPF/CNPJ obrigatorio para pagamento via Asaas. {' '}
            {/* FIX-WORKER-1 pass 3: link direto para /conta/perfil (form de edicao) */}
            <Link href="/conta/perfil" className="text-magenta underline hover:text-magenta-glow">
              Completar cadastro &rarr;
            </Link>
          </div>
        </div>
      )}

      <button onClick={pay} disabled={loading || !cart?.items_count || hasCpf === false}
        className="btn-primary w-full text-base disabled:opacity-50">
        {loading ? 'Processando...' : (hasCpf === false ? 'Complete cadastro para pagar' : 'Confirmar e pagar')}
      </button>
      {err && <div className="text-sm text-red-400 mt-3 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">{err}</div>}
    </div>
  );
}
