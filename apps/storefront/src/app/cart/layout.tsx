import type { Metadata } from 'next';

// FIX-WORKER-9 pass 7: cart layout enriquecido (era 3 campos minimo).
// canonical evita /cart?return=X duplicate URLs no Google index.
// openGraph para shares (raro mas links de cart compartilhados em chats devem
// ter preview decente vs default 'Code & Agent Shop' generico).
// follow:false explicito (era so index:false - crawler nao deve seguir CTAs internos).
export const metadata: Metadata = {
  title: 'Carrinho - Code & Agent Shop',
  description: 'Revise os produtos no seu carrinho antes de finalizar a compra.',
  alternates: { canonical: '/cart' },
  openGraph: {
    title: 'Carrinho - Code & Agent Shop',
    description: 'Seus produtos selecionados, prontos para finalizar a compra.',
    type: 'website',
    url: '/cart',
    locale: 'pt_BR',
    siteName: 'Code & Agent Shop',
  },
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
