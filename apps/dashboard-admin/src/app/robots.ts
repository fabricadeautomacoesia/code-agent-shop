import type { MetadataRoute } from 'next';

/**
 * FIX-WORKER-9 pass 177: robots.txt programmatic para dashboard-admin.
 *
 * Defesa em profundidade contra indexacao acidental do painel admin:
 *   1. metadata robots noindex (HTML meta tag) - pass 177 layout.tsx
 *   2. robots.txt Disallow: / (este arquivo) - HTTP /robots.txt
 *   3. Gateway JWT auth requireRole=admin (Express auth-svc)
 *
 * Se Google crawler tentar /sellers ou /vault, /robots.txt instrui Disallow.
 * Mesmo se URL leak (compartilhamento privado, screenshot), nao aparece em
 * search results.
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
