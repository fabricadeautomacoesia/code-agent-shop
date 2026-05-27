import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Cadastre-se - Code & Agent Shop',
  description: 'Crie sua conta gratuita como comprador ou vendedor. Comece a usar agentes IA ou venda suas automacoes.',
  // FIX-WORKER-9 pass 4: canonical explicito (register e indexavel - landing de aquisicao)
  alternates: { canonical: '/register' },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
