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
  robots: { index: false, follow: false, nocache: true },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
