import type { Metadata } from 'next';

// FIX-WORKER-9: metadata para /conta/downloads/[token] (era 'Code & Agent Shop' generico)
// Download token e sensitivo - noindex + nofollow obrigatorio.
export const metadata: Metadata = {
  title: 'Download - Code & Agent Shop',
  description: 'Baixe sua automacao licenciada. Token unico por compra.',
  robots: { index: false, follow: false, nocache: true },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
