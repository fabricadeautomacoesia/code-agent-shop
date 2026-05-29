import type { Metadata } from 'next';

// FIX-WORKER-9 pass 6: redefinir-senha layout enriquecido.
// Token nas URLs (?token=xyz) e sensitivo - canonical SEM query string +
// nocache: true forca crawlers a nunca cachear URLs autenticadas.
// noindex+nofollow+nocache = trinca de seguranca para pages com secret na URL.
export const metadata: Metadata = {
  title: 'Nova senha - Code & Agent Shop',
  description: 'Defina uma nova senha forte para sua conta.',
  alternates: { canonical: '/redefinir-senha' },
  openGraph: {
    title: 'Nova senha - Code & Agent Shop',
    description: 'Pagina segura para redefinir sua senha de acesso.',
    type: 'website',
    url: '/redefinir-senha',
    locale: 'pt_BR',
    siteName: 'Code & Agent Shop',
  },
  /* FIX-WORKER-9 pass 622 (twitter card paridade cadeia /login + /esqueci-senha + /register):
     PRE-FIX: openGraph presente mas SEM twitter card.
     - Email reset contem link /redefinir-senha?token=... compartilhado em outros
       canais (slack/whatsapp suporte). WhatsApp respeita twitter card primariamente,
       openGraph fallback. Sem twitter explicit -> preview cross-platform inconsistente.
     - Paridade cadeia 7 sites /conta/* (passes 538/557/604) + /esqueci-senha (549)
       + /login + /register. Pagina sensitive deve sempre ter twitter explicit
       p/ consistencia preview cross-platform.
     - noindex+nofollow+nocache ja protege URL ?token=... vazada em preview.
     POST-FIX: twitter card summary (sem image - reset pages nao tem hero). */
  twitter: {
    card: 'summary',
    title: 'Nova senha - Code & Agent Shop',
    description: 'Pagina segura para redefinir sua senha.',
  },
  robots: { index: false, follow: false, nocache: true },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
