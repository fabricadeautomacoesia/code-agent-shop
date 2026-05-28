/**
 * FIX-WORKER-9 pass 253: /vault metadata layout
 *
 * Page critica admin - vault de API keys LLM (AES-256-GCM). robots noindex
 * obrigatorio (mesmo se admin gateway ja bloqueie via auth, defesa em camada).
 *
 * Pattern paridade com /llm-cost, /db-audit layouts.
 */
export const metadata = {
  title: 'Vault de API keys - Admin | Code & Agent Shop',
  description: 'Cofre AES-256-GCM de chaves LLM (OpenAI/Anthropic/Gemini): provision, rotacao, revoke, BYOK sellers.',
  robots: { index: false, follow: false },
};

export default function VaultLayout({ children }: { children: React.ReactNode }) {
  return children;
}
