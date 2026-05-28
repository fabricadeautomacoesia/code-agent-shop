/**
 * FIX-WORKER-4 pass 274: layout.tsx /payouts-pending-wallet
 *
 * Admin page para visibility do payouts_pending_wallet (debt queue
 * de sellers sem asaas_wallet_id na hora da venda).
 * Backend pass 273 (endpoint) + cron pass 272 (liquidator) + schema pass 270 (mig 078).
 */
export const metadata = {
  title: 'Payouts Pendentes (sem wallet) - Admin | Code & Agent Shop',
  description: 'Debt queue de payouts aguardando seller configurar asaas_wallet_id. Cron diario liquida quando wallet disponivel.',
  robots: { index: false, follow: false },
};

export default function PayoutsPendingWalletLayout({ children }: { children: React.ReactNode }) {
  return children;
}
