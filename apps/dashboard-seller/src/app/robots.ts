import type { MetadataRoute } from 'next';

/**
 * FIX-WORKER-9 pass 177: robots.txt programmatic para dashboard-seller.
 *
 * Defesa em profundidade contra indexacao acidental do painel seller:
 *   1. metadata robots noindex (HTML meta tag) - pass 177 layout.tsx
 *   2. robots.txt Disallow: / (este arquivo) - HTTP /robots.txt
 *   3. Gateway JWT auth requireRole=seller|admin
 *
 * Dados sensiveis no painel:
 *   - KPIs receita (gross_revenue_cents, net_payout_cents)
 *   - Asaas wallet ID (financeiro)
 *   - KYC documents (CPF/CNPJ, foto identidade)
 *   - Historico vendas + comissoes
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        disallow: '/',
      },
    ],
  };
}
