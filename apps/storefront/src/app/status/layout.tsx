import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Status do Sistema - Code & Agent Shop',
  description: 'Monitor publico em tempo real: CPU, RAM, disco, uptime e status dos 16 microsservicos.',
  // FIX-WORKER-9 pass 4: canonical explicito
  alternates: { canonical: '/status' },
  // FIX-WORKER-9 pass 5: openGraph especifico
  openGraph: {
    title: 'Status do Sistema - Code & Agent Shop',
    description: 'Monitor publico em tempo real: CPU, RAM, disco, uptime e status dos 16 microsservicos da plataforma.',
    type: 'website',
    url: '/status',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Status - Code & Agent Shop',
    description: 'Monitor publico em tempo real da infraestrutura.',
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
