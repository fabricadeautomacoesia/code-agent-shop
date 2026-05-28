import './globals.css';
import type { Metadata } from 'next';
import Link from 'next/link';
import { LayoutDashboard, Package, MessageCircle, DollarSign, Settings, Upload, Star, KeyRound } from 'lucide-react';
import { PromptDialogProvider } from '@/components/prompt-dialog';

// FIX-WORKER-9 pass 177 (CRITICAL SEO/PRIVACY): paineis seller tem KPIs $, payouts,
// store_slug. Sem robots noindex, link externo acidental -> Google indexa receita,
// dados bancarios (Asaas wallet UUID), historico vendas. robots noindex defesa em
// profundidade alem do gateway JWT auth.
export const metadata: Metadata = {
  title: 'Painel do Vendedor - Code & Agent Shop',
  description: 'Painel do vendedor Code & Agent Shop. Gerencie produtos, vendas, payouts e KYC.',
  robots: { index: false, follow: false, nocache: true },
};

const NAV = [
  { href: '/',           Icon: LayoutDashboard, label: 'Visao Geral' },
  { href: '/products',   Icon: Package,         label: 'Meus produtos' },
  { href: '/upload',     Icon: Upload,          label: 'Novo produto' },
  { href: '/qna',        Icon: MessageCircle,   label: 'Q&A pendente' },
  { href: '/reviews',    Icon: Star,            label: 'Avaliacoes' },
  { href: '/financeiro', Icon: DollarSign,      label: 'Financeiro' },
  { href: '/loja',       Icon: Settings,        label: 'Minha loja' },
  // FIX-WORKER-5 pass 218: BYOK API keys (consume vault-svc seller endpoints W17-217)
  { href: '/byok',       Icon: KeyRound,        label: 'API Keys (BYOK)' },
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
              <div className="font-display font-bold text-xl">CAS <span className="text-magenta">Seller</span></div>
              <div className="text-xs text-white/40 mt-1">Painel do vendedor</div>
            </div>
            <nav className="flex-1 p-3 space-y-1">
              {NAV.map((n) => (
                <Link key={n.href} href={n.href}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/5 text-sm">
                  <n.Icon className="w-4 h-4" />
                  {n.label}
                </Link>
              ))}
            </nav>
          </aside>
          <main className="flex-1 p-8 overflow-x-hidden">{children}</main>
        </div>
        {/* FIX-WORKER-5 pass 151: PromptDialog global p/ substituir window.prompt/confirm */}
        <PromptDialogProvider />
      </body>
    </html>
  );
}
