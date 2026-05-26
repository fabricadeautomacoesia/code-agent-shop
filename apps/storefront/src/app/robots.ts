import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  const base = 'https://cas.inovareinteligenciaartificial.com';
  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/', '/products', '/product/', '/sellers', '/seller/', '/status'],
        disallow: ['/conta', '/api', '/checkout', '/cart'],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
