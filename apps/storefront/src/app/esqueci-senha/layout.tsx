import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Recuperar senha - Code & Agent Shop',
  description: 'Receba por email um link para redefinir sua senha. Link valido por 15 minutos.',
  robots: { index: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
