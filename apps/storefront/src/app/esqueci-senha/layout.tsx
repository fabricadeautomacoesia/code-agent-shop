import type { Metadata } from 'next';

// FIX-WORKER-9 pass 6: esqueci-senha layout enriquecido.
// canonical evita duplicate URLs (alguns clientes adicionam ?source=email).
// follow:false adicionado (era index:false apenas).
export const metadata: Metadata = {
  title: 'Recuperar senha - Code & Agent Shop',
  description: 'Receba por email um link para redefinir sua senha. Link valido por 15 minutos.',
  alternates: { canonical: '/esqueci-senha' },
  openGraph: {
    title: 'Recuperar senha - Code & Agent Shop',
    description: 'Receba por email um link seguro para redefinir sua senha.',
    type: 'website',
    url: '/esqueci-senha',
    locale: 'pt_BR',
    siteName: 'Code & Agent Shop',
  },
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
