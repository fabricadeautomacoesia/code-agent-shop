import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Editar perfil - Code & Agent Shop',
  description: 'Atualize seu nome, CPF/CNPJ e telefone para finalizar compras.',
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
