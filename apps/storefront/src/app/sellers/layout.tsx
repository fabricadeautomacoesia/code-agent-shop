import type { Metadata } from 'next';

/* FIX-WORKER-9 pass 704 (/sellers public layout twitter card + openGraph enrichment):
   PRE-FIX: openGraph presente MAS sem twitter card + sem url + sem siteName
   - /sellers eh PUBLIC LISTING indexavel (sem noindex)
   - Compartilhamento social /sellers em WhatsApp/Slack/X = high engagement
   - twitter card primario para cross-platform preview
   - openGraph fallback degraded sem twitter explicit
   - Paridade cadeia 12+ sites W9 metadata enrichment cross-platform
   POST-FIX: + url + siteName em openGraph + twitter summary card */
export const metadata: Metadata = {
  title: 'Vendedores - Code & Agent Shop',
  description: 'Conheca os criadores de automacoes, agentes IA e workflows n8n do marketplace. Filtre por tier de reputacao.',
  // FIX-WORKER-9 pass 3: canonical sem query strings
  alternates: { canonical: '/sellers' },
  openGraph: {
    type: 'website',
    locale: 'pt_BR',
    title: 'Vendedores - Code & Agent Shop',
    description: 'Criadores verificados de automacoes e agentes IA.',
    url: '/sellers',
    siteName: 'Code & Agent Shop',
  },
  twitter: {
    card: 'summary',
    title: 'Vendedores - Code & Agent Shop',
    description: 'Criadores verificados de automacoes e agentes IA.',
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
