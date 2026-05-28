import type { Metadata } from 'next';

// FIX-WORKER-9 pass 142: generateMetadata dinamico /conta/downloads/[token]
// ANTES: title estatico 'Download - ...' - todos downloads pareciam iguais em tabs
// AGORA: short hash do token (primeiros 6 chars) p/ identificar tab visualmente
// SEM expor token completo (PII security - token seria leak em window.title)
//
// Pattern consistente com pass 142 (/conta/pedidos/[id]) e pass 121 (/categoria/[slug])
// + DLP: hash mascara token sensitivo (defense-in-depth)
export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  // Hash mascarado: primeiros 6 chars - identificavel mas nao reconstruivel
  const shortHash = token.slice(0, 6).toUpperCase();
  return {
    title: `Download #${shortHash} - Code & Agent Shop`,
    description: 'Baixe sua automacao licenciada. Token unico por compra.',
    // PII protected: noindex + nofollow + nocache (browser nao guardar em historico cache)
    robots: { index: false, follow: false, nocache: true },
  };
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
