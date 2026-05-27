import type { Metadata } from 'next';

// FIX-WORKER-9 pass 7: /conta/perfil enriquecido (canonical + og + nocache para PII)
export const metadata: Metadata = {
  title: 'Editar perfil - Code & Agent Shop',
  description: 'Atualize seu nome, CPF/CNPJ e telefone para finalizar compras.',
  alternates: { canonical: '/conta/perfil' },
  openGraph: {
    title: 'Editar perfil - Code & Agent Shop',
    description: 'Mantenha seus dados atualizados para checkout sem fricao.',
    type: 'website',
    url: '/conta/perfil',
    locale: 'pt_BR',
    siteName: 'Code & Agent Shop',
  },
  // nocache: page com PII (CPF, telefone) - bot nunca deve cachear
  robots: { index: false, follow: false, nocache: true },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
