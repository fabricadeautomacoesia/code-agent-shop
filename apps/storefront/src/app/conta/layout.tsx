import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Minha conta - Code & Agent Shop',
  description: 'Acesse seus pedidos, downloads, favoritos e configuracoes de seguranca.',
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
