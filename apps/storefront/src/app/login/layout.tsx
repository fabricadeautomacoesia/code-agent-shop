import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Entrar - Code & Agent Shop',
  description: 'Acesse sua conta no Code & Agent Shop. Suporte 2FA TOTP para maxima seguranca.',
  robots: { index: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
