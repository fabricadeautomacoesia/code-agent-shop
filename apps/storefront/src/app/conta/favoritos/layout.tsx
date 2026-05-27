import type { Metadata } from 'next';

// FIX-WORKER-9: metadata para /conta/favoritos (era 'Code & Agent Shop' generico)
export const metadata: Metadata = {
  title: 'Meus favoritos - Code & Agent Shop',
  description: 'Lista de automacoes, agentes IA e workflows favoritados para comprar depois.',
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
