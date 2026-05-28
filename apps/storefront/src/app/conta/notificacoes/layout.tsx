import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Preferencias de Notificacao - Code & Agent Shop',
  description: 'Configure quais notificacoes voce deseja receber por email, in-app e Telegram. Opt-out de marketing emails. Alertas de seguranca sao sempre enviados (regulatorio).',
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
