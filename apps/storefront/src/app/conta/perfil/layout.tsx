import type { Metadata } from 'next';

// FIX-WORKER-9 pass 7: /conta/perfil enriquecido (canonical + og + nocache para PII)
// FIX-WORKER-9 pass 557 (twitter card paridade cadeia 431/491/518/519/538):
//   PRE-FIX (pass 7): openGraph completo MAS sem twitter card.
//   - User compartilha link em X/Twitter preview = link cru
//   - Inconsistencia cross-pages /conta/* (favoritos + notificacoes ja tinham)
//   POST-FIX: + twitter summary card. Mantido noindex+nofollow+nocache (PII).
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
  twitter: {
    card: 'summary',
    title: 'Editar perfil - Code & Agent Shop',
    description: 'Mantenha seus dados atualizados para checkout sem fricao.',
  },
  // nocache: page com PII (CPF, telefone) - bot nunca deve cachear
  robots: { index: false, follow: false, nocache: true },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
