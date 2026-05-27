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
  robots: { index: false, follow: false, nocache: true },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
