/**
 * FIX-WORKER-9 pass 250: /db-audit metadata layout
 *
 * PRE-FIX: nenhum layout.tsx -> metadata herdada root generic.
 * Compartilhar URL /db-audit em chat admin/Slack mostrava preview generico.
 * SEO: admin-only page mas indexacao Google indesejavel mesmo (admin tool).
 *
 * POST-FIX: layout.tsx com metadata especifico + robots noindex.
 */
export const metadata = {
  title: 'DB Audit - Admin | Code & Agent Shop',
  description: 'Auditoria de indices PostgreSQL: dead indexes, bloat, dead tuples, top usage.',
  robots: { index: false, follow: false },
};

export default function DbAuditLayout({ children }: { children: React.ReactNode }) {
  return children;
}
