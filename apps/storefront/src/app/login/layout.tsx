import type { Metadata } from 'next';

// FIX-WORKER-9 pass 6: login layout enriquecido.
// Antes: 3 campos basicos. Sem canonical (?return=X duplicate URLs),
// sem openGraph (links compartilhados sem preview).
// follow:false adicionado: crawler nao deve seguir links DENTRO do login
// (links para /esqueci-senha, /register sao acessoaveis por outras rotas).
export const metadata: Metadata = {
  title: 'Entrar - Code & Agent Shop',
  description: 'Acesse sua conta no Code & Agent Shop. Suporte 2FA TOTP para maxima seguranca.',
  alternates: { canonical: '/login' },
  openGraph: {
    title: 'Entrar - Code & Agent Shop',
    description: 'Acesse o maior marketplace de automacoes e agentes IA do Brasil.',
    type: 'website',
    url: '/login',
    locale: 'pt_BR',
    siteName: 'Code & Agent Shop',
  },
  twitter: {
    card: 'summary',
    title: 'Entrar - Code & Agent Shop',
    description: 'Acesse sua conta no marketplace de automacoes IA.',
  },
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
