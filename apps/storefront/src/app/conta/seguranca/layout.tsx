import type { Metadata } from 'next';

// FIX-WORKER-9: metadata para /conta/seguranca (era 'Code & Agent Shop' generico)
export const metadata: Metadata = {
  title: 'Seguranca da conta - Code & Agent Shop',
  description: 'Ative 2FA TOTP, troque sua senha e revogue sessoes ativas. Mantenha sua conta CAS protegida.',
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
