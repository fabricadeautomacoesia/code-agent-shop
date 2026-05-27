import type { Metadata } from 'next';
import './globals.css';
import { Providers } from '@/components/providers';
import { Nav } from '@/components/nav';
import { Footer } from '@/components/footer';
import { CartDrawer } from '@/components/cart-drawer';
import { CompareDrawer } from '@/components/compare-drawer';
import { JsonLd, organizationLd, webSiteLd } from '@/components/json-ld';

// FIX-WORKER-9 pass 2: metadataBase obrigatorio para Next.js resolver opengraph-image.tsx
// para URLs absolutas (https). Sem isso, og:image saia como http://localhost:3000/... e
// quebrava em todos os crawlers (WhatsApp, Twitter, FB, LinkedIn, Slack).
// NEXT_PUBLIC_SITE_URL precisa estar no .env Swarm com https://cas.inovareinteligenciaartificial.com
export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || 'https://cas.inovareinteligenciaartificial.com'),
  title: 'Code & Agent Shop - O Marketplace de Automacoes e IA',
  description: 'Compre e venda automacoes, scripts, workflows n8n e agentes de IA prontos para producao.',
  keywords: ['marketplace', 'automacao', 'agentes IA', 'n8n', 'workflows', 'scripts'],
  openGraph: {
    type: 'website',
    locale: 'pt_BR',
    title: 'Code & Agent Shop',
    description: 'Marketplace B2B/B2C de automacoes e agentes IA.',
    siteName: 'Code & Agent Shop',
  },
  // FIX-WORKER-9 pass 2: twitter card padrao tambem (inherit opengraph-image automaticamente)
  twitter: {
    card: 'summary_large_image',
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
          {/* MLB-NEW WORKER 16: comparator floating drawer (renderiza vazio se 0 items) */}
          <CompareDrawer />
          <main className="relative z-10 pt-24">{children}</main>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
