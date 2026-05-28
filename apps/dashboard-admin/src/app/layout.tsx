import './globals.css';
import type { Metadata } from 'next';
import Link from 'next/link';
import { LayoutDashboard, Users, Package, ShoppingCart, AlertTriangle, DollarSign, Activity, KeyRound, Shield, Webhook, FileText, Scale, Database, Cpu, RefreshCw, Wallet } from 'lucide-react';
import { PromptDialogProvider } from '@/components/prompt-dialog';

// FIX-WORKER-9 pass 177 (CRITICAL SEO/PRIVACY): adicionar robots noindex+nofollow
// + description + Metadata type. Antes: { title } solo - se Google crawler entrasse
// (link externo, sitemap acidental), paginas admin viriam indexadas com dados
// sensiveis em search results. robots noindex eh defesa em profundidade alem do
// gateway auth (admin JWT requireRole=admin). Pattern Mercado Livre Painel Vendedor
// + Pattern Shopify Admin: ambos noindex no robots.txt + meta tag.
export const metadata: Metadata = {
  title: 'Admin - Code & Agent Shop',
  description: 'Painel administrativo Code & Agent Shop. Acesso restrito a equipe interna.',
  robots: { index: false, follow: false, nocache: true },
};

const NAV = [
  { href: '/',            Icon: LayoutDashboard, label: 'Visao Geral' },
  { href: '/sellers',     Icon: Users,           label: 'Sellers' },
  { href: '/products',    Icon: Package,         label: 'Produtos' },
  { href: '/qa-queue',    Icon: Shield,          label: 'QA Queue' },
  { href: '/orders',      Icon: ShoppingCart,    label: 'Pedidos' },
  { href: '/payouts',     Icon: DollarSign,      label: 'Saques' },
  // FIX-WORKER-4 pass 275: Payouts pendentes (sem wallet config seller)
  // Endpoint pass 273 + UI page pass 274 - nav link agora consume
  { href: '/payouts-pending-wallet', Icon: Wallet, label: 'Payouts Sem Wallet' },
  { href: '/reports',     Icon: AlertTriangle,   label: 'Denuncias' },
  { href: '/alerts',      Icon: Activity,        label: 'Alertas AIOps' },
  { href: '/vault',       Icon: KeyRound,        label: 'Vault (API keys)' },
  // FIX-WORKER-4 pass 8: webhooks dead letter (consume /payments/webhooks/dead - W11 pass 7)
  { href: '/webhooks',    Icon: Webhook,         label: 'Webhooks Asaas' },
  // FIX-WORKER-4 pass 12: audit log (consume /aiops/audit-log - W14 pass 9 idx)
  { href: '/audit-log',   Icon: FileText,        label: 'Audit Log' },
  // FIX-WORKER-4 W7 pass 31: disputes management (consume /orders/admin/disputes + /resolve)
  { href: '/disputes',    Icon: Scale,           label: 'Disputas' },
  // FIX-WORKER-4 W18 pass 8: DB indices audit (consume /aiops/db/dead-indexes)
  { href: '/db-audit',    Icon: Database,        label: 'DB Audit' },
  // FIX-WORKER-4 pass 194: LLM Cost observability (consume /aiops/llm-cost - W4 pass 193)
  { href: '/llm-cost',    Icon: Cpu,             label: 'LLM Cost' },
  // FIX-WORKER-4 pass 209: MV KPI Refresh (consume /sellers/admin/mv-kpi/refresh - W14 pass 208)
  { href: '/mv-kpi-refresh', Icon: RefreshCw,    label: 'MV KPI Refresh' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet" />
      </head>
      <body>
        <div className="flex min-h-screen">
          <aside className="w-64 glass border-r border-white/5 rounded-none flex flex-col">
            <div className="p-5 border-b border-white/5">
              <div className="font-display font-bold text-xl">
                CAS <span className="text-magenta">Admin</span>
              </div>
              <div className="text-xs text-white/40 mt-1">Master Console</div>
            </div>
            <nav className="flex-1 p-3 space-y-1">
              {NAV.map((n) => (
                <Link key={n.href} href={n.href}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/5 transition-colors text-sm">
                  <n.Icon className="w-4 h-4" />
                  {n.label}
                </Link>
              ))}
            </nav>
            <div className="p-4 border-t border-white/5 text-xs text-white/40">
              v0.1.0 - Inovare V8
            </div>
          </aside>
          <main className="flex-1 p-8 overflow-x-hidden">{children}</main>
        </div>
        {/* FIX-WORKER-4 pass 149: PromptDialog global p/ substituir window.prompt() */}
        <PromptDialogProvider />
      </body>
    </html>
  );
}
