import type { Metadata } from 'next';

// FIX-WORKER-9 pass 431 (enriched metadata - paridade conta/favoritos + conta/perfil)
export const metadata: Metadata = {
  title: 'Preferencias de Notificacao - Code & Agent Shop',
  description: 'Configure quais notificacoes voce deseja receber por email, in-app e Telegram. Opt-out de marketing emails. Alertas de seguranca sao sempre enviados (regulatorio).',
  alternates: { canonical: '/conta/notificacoes' },
  openGraph: {
    title: 'Preferencias de Notificacao - Code & Agent Shop',
    description: 'Gerencie canais de notificacao: email, in-app, Telegram. Conformidade LGPD.',
    type: 'website',
    url: '/conta/notificacoes',
    locale: 'pt_BR',
    siteName: 'Code & Agent Shop',
  },
  twitter: {
    card: 'summary',
    title: 'Preferencias de Notificacao - Code & Agent Shop',
    description: 'Configure canais de notificacao da plataforma.',
  },
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
