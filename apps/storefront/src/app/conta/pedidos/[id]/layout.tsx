import type { Metadata } from 'next';

// FIX-WORKER-9: metadata para /conta/pedidos/[id] (era 'Code & Agent Shop' generico)
//
// FIX-WORKER-9 pass 491 (enriquecer paridade pass 142 /conta/downloads/[token]):
//   PRE-FIX: title + description + robots noindex (basico - pass inicial)
//   - SEM alternates.canonical -> SEO duplicate content theoretical (mesmo q noindex)
//   - SEM openGraph -> compartilhar link com seller via support chat mostra
//     "Code & Agent Shop" raw em vez de "Pedido #XXXXXXXX" no preview
//   - SEM locale pt_BR (pattern V8 metadata enriquecida)
//   - SEM siteName (consistencia branding)
//   - title format: `Pedido ${id.slice(0,8)}` - melhor uppercase como /downloads
//     (visual distincao em tabs + nao expor UUID completo)
//   POST-FIX:
//   - title uppercase short hash (8 chars) paridade /downloads pass 142
//   - alternates.canonical defensive (mesmo noindex)
//   - openGraph completo (title, description, type, url, locale, siteName)
//   - robots noindex + nofollow + nocache (PII protect order detail historico)
//   - PII protected: id slice(0,8) nao reconstrutivel (UUID v4 has 128 bits entropy)
type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  // Hash mascarado: primeiros 8 chars uppercase - identificavel em tab mas nao reconstruivel
  const shortHash = id.slice(0, 8).toUpperCase();
  const title = `Pedido #${shortHash} - Code & Agent Shop`;
  const description = 'Detalhes do pedido, status de pagamento, download e licencas geradas.';
  const url = `/conta/pedidos/${id}`;
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title: `Pedido #${shortHash}`,
      description,
      type: 'website',
      url,
      locale: 'pt_BR',
      siteName: 'Code & Agent Shop',
    },
    // PII protected: noindex + nofollow + nocache
    // (browser nao guardar em historico cache - paridade /downloads/[token])
    robots: { index: false, follow: false, nocache: true },
  };
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
