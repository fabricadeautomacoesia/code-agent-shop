import type { Metadata } from 'next';

// FIX-WORKER-9 pass 7: checkout layout enriquecido (era 3 campos minimo).
// canonical critico: checkout pode ter query strings (?installments=N, ?method=X)
// que viram URLs duplicadas. Canonical garante 1 URL canonical para SEO.
// nocache: true adicionado (URL pode conter session-state, jamais cachear bot).
export const metadata: Metadata = {
  title: 'Finalizar compra - Code & Agent Shop',
  description: 'Pague via PIX, cartao de credito ou boleto bancario.',
  alternates: { canonical: '/checkout' },
  openGraph: {
    title: 'Finalizar compra - Code & Agent Shop',
    description: 'Pagamento seguro via PIX, cartao ou boleto com split nativo Asaas.',
    type: 'website',
    url: '/checkout',
    locale: 'pt_BR',
    siteName: 'Code & Agent Shop',
  },
  /* FIX-WORKER-9 pass 642 (twitter card paridade cadeia auth+conta+cart pages 11 sites):
     PRE-FIX: openGraph presente mas SEM twitter card.
     - User compartilha link /checkout em chat (raro mas possivel) - preview
       cross-platform respeita twitter card primariamente, openGraph fallback
     - Paridade cadeia 10 sites previas (passes 538/557/604/622/637 + /login + /register)
     - Pagina protegida (noindex+nofollow+nocache) - trinca seguranca preserved
     POST-FIX: twitter card summary (sem image - checkout pages sem hero static). */
  twitter: {
    card: 'summary',
    title: 'Finalizar compra - Code & Agent Shop',
    description: 'Pagamento seguro via PIX, cartao ou boleto.',
  },
  robots: { index: false, follow: false, nocache: true },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
