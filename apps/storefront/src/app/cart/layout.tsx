import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Carrinho - Code & Agent Shop',
  description: 'Revise os produtos no seu carrinho antes de finalizar a compra.',
  robots: { index: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
