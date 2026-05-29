import type { Metadata } from 'next';

// FIX-WORKER-9 pass 142: generateMetadata dinamico /conta/downloads/[token]
// ANTES: title estatico 'Download - ...' - todos downloads pareciam iguais em tabs
// AGORA: short hash do token (primeiros 6 chars) p/ identificar tab visualmente
// SEM expor token completo (PII security - token seria leak em window.title)
//
// FIX-WORKER-9 pass 538 (enrich openGraph + twitter card paridade cadeia
// pass 431/491/518/519):
//   PRE-FIX pass 142: title + description + robots noindex apenas.
//   - User compartilha link download em WhatsApp/Discord preview mostrava
//     Code & Agent Shop generico (heranca root) - desencorajava cliques
//   - openGraph faltava url + siteName + locale + type
//   - twitter card faltava completamente (X preview = link cru)
//   POST-FIX pass 538: + openGraph completo (SEM url - token-specific
//   evitar leak via sitemap discovery) + twitter summary card.
//   Mantido robots noindex+nofollow+nocache (PII path token sensitivo).
//
// Pattern consistente com pass 142 (/conta/pedidos/[id]) e pass 121 (/categoria/[slug])
// + DLP: hash mascara token sensitivo (defense-in-depth)
export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  // Hash mascarado: primeiros 6 chars - identificavel mas nao reconstruivel
  const shortHash = token.slice(0, 6).toUpperCase();
  const title = `Download #${shortHash} - Code & Agent Shop`;
  const description = 'Baixe sua automacao licenciada. Token unico por compra.';
  return {
    title,
    description,
    // PII: NO canonical (token-specific url) - intencional sem canonical p/
    // evitar Google indexar token leak em sitemap discovery
    openGraph: {
      title,
      description: 'Sua automacao licenciada, pronta para baixar no maior marketplace B2B/B2C do Brasil.',
      type: 'website',
      locale: 'pt_BR',
      siteName: 'Code & Agent Shop',
    },
    twitter: {
      card: 'summary',
      title,
      description: 'Sua automacao licenciada, pronta para baixar.',
    },
    // PII protected: noindex + nofollow + nocache (browser nao guardar em historico cache)
    robots: { index: false, follow: false, nocache: true },
  };
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
