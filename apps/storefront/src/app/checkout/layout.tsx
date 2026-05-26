import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Finalizar compra - Code & Agent Shop',
  description: 'Pague via PIX, cartao de credito ou boleto bancario.',
  robots: { index: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
