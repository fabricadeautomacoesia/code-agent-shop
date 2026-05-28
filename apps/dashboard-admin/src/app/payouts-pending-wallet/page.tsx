'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { adminFetch, fmtBRL, fmtDate } from '@/lib/admin-api';
import { useAdminAction } from '@/lib/use-admin-action';
import { Clock, CheckCircle, XCircle, AlertTriangle, Wallet, Zap } from 'lucide-react';

/**
 * FIX-WORKER-4 pass 274: dashboard-admin UI page para consumir
 * GET /sellers/admin/payouts-pending-wallet (endpoint pass 273)
 *
 * Mostra:
 * - Stats cards (pending count + total amount em aberto)
 * - Filtro status (pending/liquidated/forfeited/all)
 * - Tabela payouts pendentes com store_name + wallet_configured flag
 * - Highlight visual sellers que JA tem wallet (cron deve liquidar)
 *
 * Pattern V8 consolidated: useAdminAction NAO aplicavel aqui (read-only)
 * polling 30s + pausa em background tab (paridade /admin/orders pass 6)
 */
type Payout = {
  id: string;
  order_id: string;
  seller_id: string;
  amount_cents: number;
  status: 'pending' | 'liquidated' | 'forfeited';
  reason: string;
  created_at: string;
  liquidated_at: string | null;
  forfeited_at: string | null;
  asaas_transfer_id: string | null;
  store_name: string;
  store_slug: string;
  wallet_configured: boolean;
};

const STATUS_BADGE: Record<string, { color: string; Icon: any; label: string }> = {
  pending:    { color: 'bg-yellow-500/20 text-yellow-300', Icon: Clock,          label: 'Aguardando wallet' },
  liquidated: { color: 'bg-green-500/20 text-green-300',   Icon: CheckCircle,    label: 'Liquidado' },
  forfeited:  { color: 'bg-red-500/20 text-red-300',       Icon: XCircle,        label: 'Cancelado' },
};

export default function PayoutsPendingWalletPage() {
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [status, setStatus] = useState<string>('pending');
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  async function load() {
    try {
      const r = await adminFetch<{ payouts: Payout[]; total: number }>(
        `/sellers/admin/payouts-pending-wallet?status=${status}&limit=100`
      );
      setPayouts(r.payouts || []);
      setTotal(r.total || 0);
      setError('');
      setLastUpdate(new Date());
    } catch (e: any) { setError(e.message); }
  }
  useEffect(() => {
    load();
    let i: NodeJS.Timeout | null = setInterval(load, 30000);
    const onVis = () => {
      if (document.hidden) { if (i) { clearInterval(i); i = null; } }
      else if (!i) { load(); i = setInterval(load, 30000); }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => { if (i) clearInterval(i); document.removeEventListener('visibilitychange', onVis); };
  }, [status]);

  // FIX-WORKER-4 pass 277: force-liquidate button consume pass 276 endpoint
  // Admin clica em payout pending+wallet_configured -> trigger imediato cron
  // (em vez de aguardar 24h interval). useAdminAction hook pattern V8.
  const action = useAdminAction(load);

  async function forceLiquidate(id: string, storeName: string) {
    const { confirmDialog, promptDialog } = await import('@/components/prompt-dialog');
    if (!await confirmDialog(`Forçar liquidação manual para "${storeName}"?`, {
      body: 'Audit log será gravado. Cron payment-svc processará no próximo ciclo (max 24h, tipicamente <5min).',
      variant: 'danger', confirmLabel: 'Liquidar agora',
    })) return;
    const reason = await promptDialog(
      'Motivo da liquidação manual:',
      'Ex: seller acabou de config wallet e solicita payout imediato',
      'liquidacao manual emergencial'
    ) || 'liquidacao manual emergencial';
    action.run(`liq-${id}`, async () => {
      await adminFetch(`/sellers/admin/payouts-pending-wallet/${id}/force-liquidate`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
      return `Liquidação manual disparada para ${storeName}. Cron processará em <5min.`;
    });
  }

  // Stats: pending agora podem ser liquidados (wallet configurada)
  const liquidatableNow = payouts.filter((p) => p.status === 'pending' && p.wallet_configured).length;
  const totalAmount = payouts.filter((p) => p.status === 'pending').reduce((a, p) => a + Number(p.amount_cents || 0), 0);

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-8">
        <div>
          <h1 className="font-display font-bold text-3xl sm:text-4xl">Payouts Pendentes (sem wallet)</h1>
          <p className="text-white/60 text-sm">
            Debt queue: sellers sem <code className="px-1.5 rounded bg-white/5 text-xs">asaas_wallet_id</code> na venda.
            Cron diario 24h liquida quando wallet configurada.
          </p>
        </div>
        {lastUpdate && (
          <span className="text-xs text-white/40">Atualizado: {lastUpdate.toLocaleTimeString('pt-BR')}</span>
        )}
      </div>

      {error && (
        <div role="alert" className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-lg mb-4">
          Erro: {error}
        </div>
      )}

      <div className="grid sm:grid-cols-3 gap-4 mb-8">
        <div className="glass p-5">
          <div className="stat-label flex items-center gap-2"><Clock className="w-3 h-3" aria-hidden="true" /> Pendentes</div>
          <div className="stat-value text-yellow-400">{total}</div>
        </div>
        <div className="glass p-5">
          <div className="stat-label flex items-center gap-2"><Wallet className="w-3 h-3" aria-hidden="true" /> Liquidaveis agora</div>
          <div className="stat-value text-green-400">{liquidatableNow}</div>
          <div className="text-[10px] text-white/50 mt-1">Sellers com wallet config - cron processara</div>
        </div>
        <div className="glass p-5">
          <div className="stat-label flex items-center gap-2"><AlertTriangle className="w-3 h-3" aria-hidden="true" /> Total em aberto</div>
          <div className="stat-value">{fmtBRL(totalAmount)}</div>
        </div>
      </div>

      <div className="flex gap-2 mb-4">
        {['pending', 'liquidated', 'forfeited', 'all'].map((s) => (
          <button key={s} type="button" onClick={() => setStatus(s)}
            aria-pressed={status === s}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-magenta ${
              status === s ? 'bg-magenta/20 text-magenta-glow border border-magenta/50' : 'bg-white/5 hover:bg-white/10 border border-white/10'
            }`}>
            {s}
          </button>
        ))}
      </div>

      {/* FIX-WORKER-4 pass 277: action feedback banners */}
      {action.error && (
        <div role="alert" className="bg-red-500/10 border border-red-500/30 text-red-400 p-3 rounded-lg mb-4 flex items-center justify-between">
          <span className="text-sm">{action.error}</span>
          <button type="button" onClick={action.clear} aria-label="Fechar erro"
            className="text-xs hover:underline">fechar</button>
        </div>
      )}
      {action.success && (
        <div role="status" aria-live="polite" className="bg-green-500/10 border border-green-500/30 text-green-400 p-3 rounded-lg mb-4 flex items-center justify-between">
          <span className="text-sm">{action.success}</span>
          <button type="button" onClick={action.clear} aria-label="Fechar sucesso"
            className="text-xs hover:underline">fechar</button>
        </div>
      )}

      <div className="glass p-6 overflow-x-auto">
        {payouts.length === 0 ? (
          <p className="text-white/60 text-center py-12">
            {status === 'pending' ? 'Nenhum payout pendente. Bom sinal - sellers tem wallets configuradas.' : `Nenhum payout em ${status}.`}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-white/40 uppercase border-b border-white/10">
              <tr>
                <th className="py-2">Seller</th><th>Valor</th><th>Wallet</th><th>Status</th>
                <th>Order</th><th>Criado</th><th className="text-right">Acoes</th>
              </tr>
            </thead>
            <tbody>
              {payouts.map((p) => {
                const badge = STATUS_BADGE[p.status] || STATUS_BADGE.pending;
                return (
                  <tr key={p.id} className="border-b border-white/5 hover:bg-white/5">
                    <td className="py-3">
                      <Link href={`/sellers?slug=${p.store_slug}`} className="hover:text-magenta">{p.store_name}</Link>
                    </td>
                    <td className="font-display font-bold text-magenta-glow">{fmtBRL(p.amount_cents)}</td>
                    <td>
                      {p.wallet_configured ? (
                        <span className="text-green-400 text-xs flex items-center gap-1">
                          <Wallet className="w-3 h-3" aria-hidden="true" /> Configurada
                        </span>
                      ) : (
                        <span className="text-orange-300 text-xs flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3" aria-hidden="true" /> Pendente
                        </span>
                      )}
                    </td>
                    <td>
                      <span className={`px-2 py-0.5 rounded text-xs ${badge.color}`}>{badge.label}</span>
                    </td>
                    <td className="font-mono text-xs text-white/40">{p.order_id.slice(0, 8)}...</td>
                    <td className="text-xs text-white/40">{fmtDate(p.created_at)}</td>
                    <td className="text-right">
                      {/* Force-liquidate button - so para pending+wallet_configured */}
                      {p.status === 'pending' && p.wallet_configured && (
                        <button type="button"
                          onClick={() => forceLiquidate(p.id, p.store_name)}
                          disabled={action.busyKey === `liq-${p.id}`}
                          aria-label={`Forçar liquidação manual para ${p.store_name}`}
                          className="text-magenta hover:underline text-xs inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-wait focus-visible:outline-2 focus-visible:outline-magenta rounded">
                          <Zap className="w-3 h-3" aria-hidden="true" />
                          {action.busyKey === `liq-${p.id}` ? '...' : 'Liquidar'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
