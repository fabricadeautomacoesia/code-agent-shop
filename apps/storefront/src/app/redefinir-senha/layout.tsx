import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Nova senha - Code & Agent Shop',
  description: 'Defina uma nova senha forte para sua conta.',
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
