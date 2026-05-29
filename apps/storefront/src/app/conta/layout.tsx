import type { Metadata } from 'next';

/* FIX-WORKER-9 pass 695 (/conta root layout enrichment paridade cadeia 11 sites cumulative):
   PRE-FIX: 3 campos minimo (title + description + robots).
   - Sem canonical -> /conta?ref=X duplicate URLs no Google index
   - Sem openGraph -> shares em chat (raro mas possivel) preview generico
   - Sem twitter card -> WhatsApp/Slack preview cross-platform degraded
   - Paridade cadeia 11 sites (/login, /esqueci-senha, /redefinir-senha, /register,
     /conta/* downloads/seguranca/perfil/pontos/pedidos, /cart, /checkout)
   - /conta root era ULTIMO conta layout lagged sem metadata completa
   POST-FIX: full metadata enrichment paridade cadeia:
   - canonical '/conta' (anti duplicate-URL Google)
   - openGraph completo (type/url/locale/siteName)
   - twitter card summary (sem image - account pages sem hero static)
   - robots noindex+follow=false preserved (auth-protected page) */
export const metadata: Metadata = {
  title: 'Minha conta - Code & Agent Shop',
  description: 'Acesse seus pedidos, downloads, favoritos e configuracoes de seguranca.',
  alternates: { canonical: '/conta' },
  openGraph: {
    title: 'Minha conta - Code & Agent Shop',
    description: 'Painel pessoal: pedidos, downloads, favoritos e seguranca.',
    type: 'website',
    url: '/conta',
    locale: 'pt_BR',
    siteName: 'Code & Agent Shop',
  },
  twitter: {
    card: 'summary',
    title: 'Minha conta - Code & Agent Shop',
    description: 'Painel pessoal: pedidos, downloads, favoritos e seguranca.',
  },
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
