'use client';

import { useEffect, useState } from 'react';
import { sellerFetch, fmtBRL, fmtDate } from '@/lib/seller-api';
import { TrendingUp, Wallet, ArrowDownToLine, Clock, CheckCircle2, XCircle, Banknote } from 'lucide-react';

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
  const [amount, setAmount] = useState(0);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');

  async function load() {
    try {
      const [k, p] = await Promise.all([
        sellerFetch<{ kpi: any }>('/sellers/me/kpi'),
        sellerFetch<{ payouts: any[] }>('/sellers/me/payouts').catch(() => ({ payouts: [] })),
      ]);
      setKpi(k.kpi);
      setPayouts(p.payouts || []);
    } catch (e: any) { setError(e.message); }
  }
  useEffect(() => { load(); }, []);

  async function requestPayout(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setOk('');
    try {
      await sellerFetch('/sellers/me/payout', { method: 'POST', body: JSON.stringify({ amount_cents: amount * 100 }) });
      setOk(`Saque de ${fmtBRL(amount*100)} solicitado. Aguardando aprovacao admin.`);
      setAmount(0);
      load();
    } catch (e: any) { setError(e.message); }
  }

  return (
    <div>
      <h1 className="font-display font-bold text-4xl mb-2">Financeiro</h1>
      <p className="text-white/60 mb-8">Receita liquida, comissoes e solicitacao de saques</p>

      <div className="grid md:grid-cols-3 gap-4 mb-8">
        <div className="glass p-6">
          <div className="text-xs text-white/50 uppercase mb-1 flex items-center gap-2">
            <Wallet className="w-3 h-3" /> Receita bruta
          </div>
          <div className="font-display font-bold text-3xl">{fmtBRL(kpi?.gross_revenue_cents || 0)}</div>
        </div>
        <div className="glass p-6">
          <div className="text-xs text-white/50 uppercase mb-1">Comissao plataforma (18%)</div>
          <div className="font-display font-bold text-3xl text-white/60">- {fmtBRL(kpi?.platform_commission_cents || 0)}</div>
        </div>
        <div className="glass p-6 border-magenta border-2">
          <div className="text-xs text-magenta-glow uppercase mb-1 flex items-center gap-2">
            <TrendingUp className="w-3 h-3" /> Receita liquida (82%)
          </div>
          <div className="font-display font-bold text-3xl text-magenta-glow">{fmtBRL(kpi?.net_payout_cents || 0)}</div>
        </div>
      </div>

      <div className="glass p-6 max-w-lg">
        <h3 className="font-display font-bold text-xl mb-4 flex items-center gap-2">
          <ArrowDownToLine className="w-5 h-5 text-magenta" /> Solicitar saque
        </h3>
        <p className="text-sm text-white/60 mb-4">
          Saque minimo R$ 50,00. Apos aprovacao do admin, a transferencia e processada via Asaas.
        </p>
        <form onSubmit={requestPayout} className="space-y-3">
          <div>
            <label className="text-xs text-white/60 uppercase">Valor em reais</label>
            <input type="number" min={50} step="0.01" value={amount} onChange={(e) => setAmount(Number(e.target.value))}
              className="w-full px-3 py-2 mt-1 rounded bg-white/5 border border-white/10 text-lg font-mono" />
          </div>
          <button type="submit" className="btn-primary w-full">Solicitar saque</button>
          {error && <div className="text-red-400 text-sm">{error}</div>}
          {ok && <div className="text-green-400 text-sm">{ok}</div>}
        </form>
      </div>

      {/* FIX-WORKER-5: historico de payouts (visibility fix - seller agora ve status real) */}
      <div className="glass p-6 mt-8">
        <h3 className="font-display font-bold text-xl mb-4">Historico de saques</h3>
        {payouts.length === 0 ? (
          <p className="text-white/60 text-center py-8 text-sm">
            Nenhum saque solicitado ainda.
          </p>
        ) : (
          <div className="divide-y divide-white/5">
            {payouts.map((p) => {
              const info = PAYOUT_STATUS[p.status] || { label: p.status, icon: Clock, color: 'text-white/60' };
              const Icon = info.icon;
              return (
                <div key={p.id} className="flex items-center gap-3 py-3">
                  <div className={`w-9 h-9 rounded-full bg-white/5 flex items-center justify-center flex-shrink-0 ${info.color}`}>
                    <Icon className="w-4 h-4" />
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
