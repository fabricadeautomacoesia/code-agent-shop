import type { Metadata } from 'next';
import './globals.css';
import { Providers } from '@/components/providers';
import { Nav } from '@/components/nav';
import { Footer } from '@/components/footer';
import { CartDrawer } from '@/components/cart-drawer';
import { JsonLd, organizationLd, webSiteLd } from '@/components/json-ld';

export const metadata: Metadata = {
  title: 'Code & Agent Shop - O Marketplace de Automacoes e IA',
  description: 'Compre e venda automacoes, scripts, workflows n8n e agentes de IA prontos para producao.',
  keywords: ['marketplace', 'automacao', 'agentes IA', 'n8n', 'workflows', 'scripts'],
  openGraph: {
    type: 'website',
    locale: 'pt_BR',
    title: 'Code & Agent Shop',
    description: 'Marketplace B2B/B2C de automacoes e agentes IA.',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet" />
        <script dangerouslySetInnerHTML={{__html:`
          window.addEventListener('error', function(e){ console.error('[Fatal]', e.message); e.preventDefault(); });
          window.addEventListener('unhandledrejection', function(e){ console.error('[Promise]', e.reason); e.preventDefault(); });
        `}}/>
        {/* FIX-WORKER-9 pass 3: JSON-LD Organization + WebSite SearchAction (sitelinks search box no Google) */}
        <JsonLd data={organizationLd()} />
        <JsonLd data={webSiteLd()} />
      </head>
      <body className="min-h-screen relative overflow-x-hidden">
        <div className="grid-bg" aria-hidden />
        <div className="noise-overlay" aria-hidden />
        <Providers>
          <Nav />
          <CartDrawer />
          <main className="relative z-10 pt-24">{children}</main>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
