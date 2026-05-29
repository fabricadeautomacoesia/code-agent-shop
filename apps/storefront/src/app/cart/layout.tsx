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
  /* FIX-WORKER-9 pass 637 (twitter card paridade cadeia auth+conta pages 10 sites):
     PRE-FIX: openGraph presente mas SEM twitter card.
     - User compartilha link /cart em chat (WhatsApp/Slack/X) - preview cross-platform
       respeita twitter card primariamente, openGraph fallback (assimetria preview)
     - Paridade cadeia 9 sites previas (/login, /esqueci-senha, /redefinir-senha,
       /register + /conta/* downloads/seguranca/perfil/pontos/pedidos)
     - Pagina protegida (noindex+nofollow), mas preview link compartilhado deve ser
       consistente independente platform - sem twitter explicit = fallback degraded
     POST-FIX: twitter card summary (sem image - cart pages sem hero static). */
  twitter: {
    card: 'summary',
    title: 'Carrinho - Code & Agent Shop',
    description: 'Seus produtos selecionados, prontos para finalizar a compra.',
  },
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
