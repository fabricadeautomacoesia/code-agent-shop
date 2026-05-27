import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  const base = 'https://cas.inovareinteligenciaartificial.com';
  return {
    rules: [
      {
        userAgent: '*',
        allow: [
          '/',
          '/products',
          '/product/',
          '/sellers',
          '/seller/',
          '/categoria/',
          '/promocoes',
          '/comparar',
          '/cloud-code-ilimitado',
          '/sobre',
          '/termos',
          '/privacidade',
          '/status',
        ],
        disallow: [
          '/conta',
          '/conta/',
          '/api',
          '/api/',
          '/checkout',
          '/cart',
          '/login',
          '/register',
          '/esqueci-senha',
          '/redefinir-senha',
          '/seller/dashboard',
          '/seller/upload',
        ],
      },
      // crawlers indesejados/agressivos (otimizacao de banda)
      {
        userAgent: ['SemrushBot', 'AhrefsBot', 'DotBot', 'PetalBot', 'MJ12bot'],
        disallow: ['/'],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
