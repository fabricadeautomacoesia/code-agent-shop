import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Cadastre-se - Code & Agent Shop',
  description: 'Crie sua conta gratuita como comprador ou vendedor. Comece a usar agentes IA ou venda suas automacoes.',
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
