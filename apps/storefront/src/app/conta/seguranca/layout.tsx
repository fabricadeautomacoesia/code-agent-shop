import type { Metadata } from 'next';

// FIX-WORKER-9 pass 7: /conta/seguranca enriquecido (2FA setup - max security headers)
export const metadata: Metadata = {
  title: 'Seguranca da conta - Code & Agent Shop',
  description: 'Ative 2FA TOTP, troque sua senha e revogue sessoes ativas. Mantenha sua conta CAS protegida.',
  alternates: { canonical: '/conta/seguranca' },
  openGraph: {
    title: 'Seguranca da conta - Code & Agent Shop',
    description: 'Proteja sua conta com 2FA TOTP e gerencie sessoes ativas.',
    type: 'website',
    url: '/conta/seguranca',
    locale: 'pt_BR',
    siteName: 'Code & Agent Shop',
  },
  // Trinca seguranca: noindex + nofollow + nocache (QR 2FA + recovery codes
  // jamais devem ser indexados ou cacheados por crawlers)
  robots: { index: false, follow: false, nocache: true },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
