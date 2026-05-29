import type { Metadata } from 'next';
import Link from 'next/link';
import { AlertTriangle, ArrowLeft, Search } from 'lucide-react';

/* FIX-WORKER-9 pass 466: metadata explicit not-found.tsx
   PRE-FIX: not-found sem export metadata -> herdava root layout generic
   "Code & Agent Shop" como title em 404 pages.
   - Browser tab title: "Code & Agent Shop" (enganoso - era 404)
   - User compartilha URL quebrada em chat -> preview brand normal
     (parece link valido com produto OK - induz confianca falsa)
   - SEO: Google indexa 404 page com title de homepage = duplicate content
   - openGraph: share URL quebrada em WhatsApp/Twitter -> preview marca como
     pagina principal CAS
   POST-FIX: metadata 404 explicit:
   - title clear (404)
   - description explica erro
   - robots noindex (Google NAO indexa 404 - waste crawl budget)
   - openGraph type=website + locale pt_BR + siteName
   Paridade ecosystem MLB/Amazon - 404 pages tem metadata distinto. */
export const metadata: Metadata = {
  title: 'Pagina nao encontrada - 404 - Code & Agent Shop',
  description: 'A pagina solicitada nao foi encontrada na plataforma. Use a busca ou explore o catalogo.',
  robots: { index: false, follow: false },
  openGraph: {
    title: 'Pagina nao encontrada - Code & Agent Shop',
    description: 'Esta URL nao existe ou foi movida. Acesse cas.inovareinteligenciaartificial.com para buscar produtos.',
    type: 'website',
    locale: 'pt_BR',
    siteName: 'Code & Agent Shop',
  },
  twitter: {
    card: 'summary',
    title: 'Pagina nao encontrada - Code & Agent Shop',
    description: 'URL nao existe ou foi movida.',
  },
};

export default function NotFound() {
  return (
    <div className="container mx-auto px-6 py-32 max-w-2xl text-center">
      <div className="glass p-12">
        <div className="text-9xl font-display font-bold bg-gradient-vibe bg-clip-text text-transparent mb-4">
          404
        </div>
        <AlertTriangle className="w-16 h-16 mx-auto mb-4 text-magenta opacity-50" />
        <h1 className="font-display font-bold text-3xl mb-3">Pagina nao encontrada</h1>
        <p className="text-white/60 mb-8">
          A pagina que voce procura nao existe ou foi movida.
        </p>
        <div className="flex flex-wrap gap-3 justify-center">
          <Link href="/" className="btn-primary inline-flex items-center gap-2">
            <ArrowLeft className="w-4 h-4" /> Voltar para a Home
          </Link>
          <Link href="/products" className="btn-ghost inline-flex items-center gap-2">
            <Search className="w-4 h-4" /> Explorar catalogo
          </Link>
        </div>
      </div>
    </div>
  );
}
