'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { sellerFetch, fmtBRL, fmtDate } from '@/lib/seller-api';
import { useSellerAction } from '@/lib/use-seller-action';
import { TrendingUp, Wallet, ArrowDownToLine, Clock, CheckCircle2, XCircle, Banknote, AlertTriangle } from 'lucide-react';

// FIX-WORKER-5: mapa visual para status de payouts (estilo MLB extrato)
const PAYOUT_STATUS: Record<string, { label: string; icon: any; color: string }> = {
  pending:   { label: 'Aguardando aprovacao', icon: Clock,        color: 'text-yellow-400' },
  approved:  { label: 'Aprovado, processando', icon: CheckCircle2, color: 'text-blue-300' },
  paid:      { label: 'Pago',                  icon: Banknote,     color: 'text-green-400' },
  rejected:  { label: 'Rejeitado',             icon: XCircle,      color: 'text-red-400' },
};

export default function FinanceiroPage() {
  const [kpi, setKpi] = useState<any>(null);
  const [payouts, setPayouts] = useState<any[]>([]);
  // FIX-WORKER-5 pass 6: amount como string vazia (placeholder visivel, sem "0" persistente)
  const [amount, setAmount] = useState<string>('');
  const [loadError, setLoadError] = useState('');

  /* FIX-WORKER-5 pass 740 (useCallback stable closure - paridade pass 738/739 dashboard-admin):
     PRE-FIX BUG: async function load() recriada cada render.
     - useSellerAction(load) recebe nova reference cada render
     - useCallback dentro de useSellerAction tem deps [busyKey, reload]
       -> reload muda cada render -> `run` re-criada cada render
     - useEffect deps [] ignora load completamente (eslint-disable-next-line implicit)
       -> load INITIAL chamada apenas, ok aqui (mount-only intentional)
     - Mas useSellerAction reload tambem stale per render race window
     POST-FIX (paridade cadeia W4 dashboard-admin 738+739, agora W5 dashboard-seller 740):
     - useCallback wrap em load com [] deps -> stable reference (sem state externo dependente)
     - useSellerAction recebe stable callback -> action.run estavel
     - useEffect deps [load] - paridade ESLint exhaustive-deps
     - Pattern V8 W5 React stability cadeia 3 sites (738 disputes, 739 payouts-pending, 740 financeiro). */
  const load = useCallback(async () => {
    try {
      const [k, p] = await Promise.all([
        sellerFetch<{ kpi: any }>('/sellers/me/kpi'),
        sellerFetch<{ payouts: any[] }>('/sellers/me/payouts').catch(() => ({ payouts: [] })),
      ]);
      setKpi(k.kpi);
      setPayouts(p.payouts || []);
      setLoadError('');
    } catch (e: any) { setLoadError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // FIX-WORKER-5 pass 6 (FINAL FINAL): /financeiro era ultima page com error/ok
  // ad-hoc states. Agora migrada para useSellerAction hook (passes 1-5 pattern).
  // Cobertura dashboard-seller: 6/6 write pages no hook (100% definitivo).
  const action = useSellerAction(load);

  /* FIX-WORKER-5 pass 287: state inline p/ wallet_not_configured (consome
     backend pass 286). useSellerAction generic so trata error string; aqui
     precisamos data.action_url p/ CTA "Configurar carteira". */
  const [walletAlert, setWalletAlert] = useState<{ msg: string; actionUrl: string } | null>(null);

  async function requestPayout(e: React.FormEvent) {
    e.preventDefault();
    setWalletAlert(null);
    // FIX-WORKER-5 pass 405 (PT-BR comma decimal parse):
    //   PRE-FIX: parseFloat(amount) - user digita "100,50" -> 100 (cents perdidos)
    //   - type=number HTML5 forca decimal '.' MAS alguns mobile/locale PT-BR
    //     aceitam vírgula via OS picker (Brasil number keypad)
    //   - Backend recebe R$100 em vez de R$100.50 = 50 centavos perdidos
    //   - Silent precision loss em payout requests = compliance gap audit
    //   POST-FIX: normalize comma->dot ANTES parseFloat (paridade qa-worker pass 387)
    //   Pattern V8 cross-svc: PT-BR comma normalization sempre
    const normalized = amount.replace(',', '.').trim();
    const value = parseFloat(normalized);
    if (!value || isNaN(value) || value < 50) {
      action.run('payout', async () => { throw new Error('Valor minimo R$ 50,00'); });
      return;
    }
    action.run('payout', async () => {
      // FIX-WORKER-5 pass 6: Math.round evita floating-point (50.5 * 100 = 5050.0000000000005)
      const amountCents = Math.round(value * 100);
      try {
        await sellerFetch('/sellers/me/payout', {
          method: 'POST',
          body: JSON.stringify({ amount_cents: amountCents })
        });
      } catch (e: any) {
        /* FIX-WORKER-5 pass 287: trata 403 wallet_not_configured (pass 286 backend)
           Mostra banner especifico com CTA /seller/loja em vez de erro generico. */
        if (e?.status === 403 && e?.data?.error === 'wallet_not_configured') {
          setWalletAlert({
            msg: e.data.message || 'Carteira Asaas nao configurada.',
            actionUrl: e.data.action_url || '/seller/loja',
          });
          throw new Error('Carteira nao configurada - configure em /seller/loja');
        }
        throw e;
      }
      setAmount('');
      return `Saque de ${fmtBRL(amountCents)} solicitado. Aguardando aprovacao admin.`;
    });
  }

  return (
    <div>
      <h1 className="font-display font-bold text-4xl mb-2">Financeiro</h1>
      <p className="text-white/60 mb-6">Receita liquida, comissoes e solicitacao de saques</p>

      {/* FIX-WORKER-5 pass 6: banners centralizados (era inline no form) */}
      {/* FIX-WORKER-5 pass 240 (a11y parity): loadError sem role=alert mesmo
          quando action.error (linha 68) e action.success (75) ja tem. Screen
          reader nao anunciava falha de carregamento (UX confuso: page parece
          vazia mas erro silencioso). Pattern V8: all error displays need
          role=alert + (decorative icon aria-hidden, if any). */}
      {loadError && (
        <div role="alert" className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg mb-4">
          Erro carregando dados: {loadError}
        </div>
      )}
      {/* FIX-WORKER-5 pass 287: wallet_not_configured alert com CTA /seller/loja
          (consome backend pass 286). Aparece DEPOIS de payout request 403.
          FIX-WORKER-5 pass 568: Link CTA focus-visible outline (paridade cadeia 549/552). */}
      {walletAlert && (
        <div role="alert" className="bg-orange-500/10 border border-orange-500/30 text-orange-200 p-4 rounded-lg mb-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-orange-300 flex-shrink-0 mt-0.5" aria-hidden="true" />
          <div className="flex-1">
            <div className="font-semibold mb-1">Carteira nao configurada</div>
            <p className="text-sm text-white/70 mb-3">{walletAlert.msg}</p>
            <div className="flex gap-2">
              <Link href={walletAlert.actionUrl}
                className="btn-primary text-xs px-3 py-1.5 inline-flex items-center gap-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-magenta">
                Configurar carteira
              </Link>
              <button type="button" onClick={() => setWalletAlert(null)}
                aria-label="Fechar alerta de carteira"
                className="text-xs px-3 py-1.5 rounded border border-white/10 hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-orange-400">
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
      {/* FIX-WORKER-5 pass 172 (a11y V8 R23): role=alert/status + type=button + aria-label */}
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

      {/* FIX-WORKER-5 pass 568 (a11y - paridade cadeia pass 541/561 icons consolidacao):
          KPI/CTA icons decorativos (Wallet/TrendingUp/ArrowDownToLine) + texto
          descritivo = aria-hidden. SR (NVDA/JAWS) anunciava 'imagem Wallet'
          antes de 'Receita bruta' = noise audio per page load. */}
      <div className="grid md:grid-cols-3 gap-4 mb-8">
        <div className="glass p-6">
          <div className="text-xs text-white/50 uppercase mb-1 flex items-center gap-2">
            <Wallet className="w-3 h-3" aria-hidden="true" /> Receita bruta
          </div>
          <div className="font-display font-bold text-3xl">{fmtBRL(kpi?.gross_revenue_cents || 0)}</div>
        </div>
        <div className="glass p-6">
          <div className="text-xs text-white/50 uppercase mb-1">Comissao plataforma (18%)</div>
          <div className="font-display font-bold text-3xl text-white/60">- {fmtBRL(kpi?.platform_commission_cents || 0)}</div>
        </div>
        <div className="glass p-6 border-magenta border-2">
          <div className="text-xs text-magenta-glow uppercase mb-1 flex items-center gap-2">
            <TrendingUp className="w-3 h-3" aria-hidden="true" /> Receita liquida (82%)
          </div>
          <div className="font-display font-bold text-3xl text-magenta-glow">{fmtBRL(kpi?.net_payout_cents || 0)}</div>
        </div>
      </div>

      <div className="glass p-6 max-w-lg">
        <h3 className="font-display font-bold text-xl mb-4 flex items-center gap-2">
          <ArrowDownToLine className="w-5 h-5 text-magenta" aria-hidden="true" /> Solicitar saque
        </h3>
        <p className="text-sm text-white/60 mb-4">
          Saque minimo R$ 50,00. Apos aprovacao do admin, a transferencia e processada via Asaas.
        </p>
        {/* FIX-WORKER-5 pass 6: form com disabled state + amount string (placeholder visivel) */}
        <form onSubmit={requestPayout} className="space-y-3">
          <div>
            <label className="text-xs text-white/60 uppercase">Valor em reais</label>
            <input type="number" min={50} step="0.01" inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="50.00"
              disabled={action.busyKey === 'payout'}
              className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-lg font-mono focus:border-magenta focus:outline-none disabled:opacity-50" />
            <div className="text-[11px] text-white/40 mt-1">Saque liquido disponivel: <strong className="text-white/70">{fmtBRL(kpi?.net_payout_cents || 0)}</strong></div>
          </div>
          {/* FIX pass 405: paridade comma normalization no disabled check
              FIX-WORKER-5 pass 568 (a11y CTA - paridade cadeia 549/552/553):
              + aria-busy={busy} (SR announce processing state)
              + aria-label dinamico contextual rich
              + focus-visible:outline magenta (kbd nav affordance) */}
          <button type="submit"
            disabled={action.busyKey === 'payout' || !amount || parseFloat(amount.replace(',', '.')) < 50}
            aria-busy={action.busyKey === 'payout'}
            aria-label={action.busyKey === 'payout' ? 'Solicitando saque' : 'Solicitar saque do valor digitado'}
            className="btn-primary w-full disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-magenta">
            {action.busyKey === 'payout' ? 'Solicitando...' : 'Solicitar saque'}
          </button>
        </form>
      </div>

      {/* FIX-WORKER-5: historico de payouts (visibility fix - seller agora ve status real) */}
      <div className="glass p-6 mt-8">
        <h3 className="font-display font-bold text-xl mb-4">Historico de saques</h3>
        {payouts.length === 0 ? (
          /* FIX-WORKER-5 pass 568 (a11y empty state - paridade pass 544/556/565):
             role=status + sem icon aqui (text-only zero state). */
          <p role="status" className="text-white/60 text-center py-8 text-sm">
            Nenhum saque solicitado ainda.
          </p>
        ) : (
          <div className="divide-y divide-white/5">
            {payouts.map((p) => {
              const info = PAYOUT_STATUS[p.status] || { label: p.status, icon: Clock, color: 'text-white/60' };
              const Icon = info.icon;
              return (
                <div key={p.id} className="flex items-center gap-3 py-3">
                  {/* FIX-WORKER-5 pass 568 (a11y - Icon status payout aria-hidden):
                      Icon decorativo (Clock/CheckCircle2/Banknote/XCircle) + texto
                      info.label ('Aguardando aprovacao' etc) descritivo proximo.
                      SR duplicava 'imagem Clock' + 'Aguardando aprovacao'. */}
                  <div className={`w-9 h-9 rounded-full bg-white/5 flex items-center justify-center flex-shrink-0 ${info.color}`}>
                    <Icon className="w-4 h-4" aria-hidden="true" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold">{info.label}</div>
                    <div className="text-[11px] text-white/40">
                      Solicitado em {fmtDate(p.requested_at)}
                      {p.paid_at && <> - Pago em {fmtDate(p.paid_at)}</>}
                      {p.asaas_transfer_id && <> - Asaas <span className="font-mono">{p.asaas_transfer_id.slice(0,12)}</span></>}
                    </div>
                    {p.rejected_reason && (
                      <div className="text-[11px] text-red-400 mt-0.5">Motivo: {p.rejected_reason}</div>
                    )}
                  </div>
                  <div className="font-display font-bold text-base whitespace-nowrap text-magenta-glow">
                    {fmtBRL(Number(p.amount_cents))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
