/**
 * FIX-WORKER-9 pass 253: /webhooks metadata layout
 *
 * Webhook dead-letter queue admin (Asaas events que falharam). Sensitive
 * payment audit - robots noindex obrigatorio.
 */
export const metadata = {
  title: 'Webhooks - Admin | Code & Agent Shop',
  description: 'Dead-letter queue de webhooks Asaas (payment events failed). Reprocess manual + investigation.',
  robots: { index: false, follow: false },
};

export default function WebhooksLayout({ children }: { children: React.ReactNode }) {
  return children;
}
