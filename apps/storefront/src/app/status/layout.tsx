import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Status do Sistema - Code & Agent Shop',
  description: 'Monitor publico em tempo real: CPU, RAM, disco, uptime e status dos 16 microsservicos.',
  // FIX-WORKER-9 pass 4: canonical explicito
  alternates: { canonical: '/status' },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
