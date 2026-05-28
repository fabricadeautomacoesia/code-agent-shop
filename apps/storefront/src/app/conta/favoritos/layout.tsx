import type { Metadata } from 'next';

// FIX-WORKER-9 pass 431 (enriched metadata - paridade conta/pontos/perfil/seguranca):
//   PRE-FIX: title + description + robots noindex apenas.
//   - User compartilha link wishlist /conta/favoritos em WhatsApp/Discord
//     preview mostra Code & Agent Shop generico (heranca root)
//   - openGraph nao especifica type website ou siteName
//   - canonical missing -> Google indexava varios paths se index acidentalmente
//   POST-FIX: + canonical + openGraph completo + twitter card + siteName
//   Paridade conta/perfil pass 7 + conta/pontos pass 7 (consolidacao final).
//   Mantido robots noindex (PII path user-specific).
export const metadata: Metadata = {
  title: 'Meus favoritos - Code & Agent Shop',
  description: 'Lista de automacoes, agentes IA e workflows favoritados para comprar depois.',
  alternates: { canonical: '/conta/favoritos' },
  openGraph: {
    title: 'Meus favoritos - Code & Agent Shop',
    description: 'Sua wishlist de automacoes e agentes IA no maior marketplace B2B/B2C do Brasil.',
    type: 'website',
    url: '/conta/favoritos',
    locale: 'pt_BR',
    siteName: 'Code & Agent Shop',
  },
  twitter: {
    card: 'summary',
    title: 'Meus favoritos - Code & Agent Shop',
    description: 'Sua wishlist de automacoes e agentes IA.',
  },
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
