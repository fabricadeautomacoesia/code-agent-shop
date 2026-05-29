import type { Metadata } from 'next';

// FIX-WORKER-9 pass 7: /conta/seguranca enriquecido (2FA setup - max security headers)
// FIX-WORKER-9 pass 557 (twitter card paridade pass 431/491/518/519/538 cadeia):
//   PRE-FIX (pass 7): openGraph completo MAS sem twitter card.
//   - User compartilha link em X/Twitter preview = link cru sem metadata
//   - Inconsistencia cross-pages /conta/* (favoritos + notificacoes ja tinham)
//   POST-FIX: + twitter summary card (paridade cadeia W9 consolidation).
//   Mantido noindex+nofollow+nocache (2FA QR + recovery codes path).
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
  twitter: {
    card: 'summary',
    title: 'Seguranca da conta - Code & Agent Shop',
    description: 'Proteja sua conta com 2FA TOTP no maior marketplace B2B/B2C de automacoes IA.',
  },
  // Trinca seguranca: noindex + nofollow + nocache (QR 2FA + recovery codes
  // jamais devem ser indexados ou cacheados por crawlers)
  robots: { index: false, follow: false, nocache: true },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
