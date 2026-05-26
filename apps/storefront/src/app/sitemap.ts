import type { MetadataRoute } from 'next';

const BASE = 'https://cas.inovareinteligenciaartificial.com';
const API_BASE = process.env.GATEWAY_URL || 'http://127.0.0.1:3002';

async function fetchAll(path: string): Promise<any> {
  try {
    const r = await fetch(`${API_BASE}${path}`, { cache: 'no-store' });
    if (!r.ok) return null;
    return r.json();
  } catch { return null; }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // Paginas estaticas
  const staticPages: MetadataRoute.Sitemap = [
    { url: BASE,                       lastModified: new Date(), changeFrequency: 'daily',  priority: 1.0 },
    { url: `${BASE}/products`,         lastModified: new Date(), changeFrequency: 'hourly', priority: 0.9 },
    { url: `${BASE}/sellers`,          lastModified: new Date(), changeFrequency: 'daily',  priority: 0.7 },
    { url: `${BASE}/status`,           lastModified: new Date(), changeFrequency: 'always', priority: 0.5 },
    { url: `${BASE}/login`,            lastModified: new Date(), changeFrequency: 'monthly', priority: 0.3 },
    { url: `${BASE}/register`,         lastModified: new Date(), changeFrequency: 'monthly', priority: 0.5 },
  ];

  // Produtos dinamicos
  const productsRes: any = await fetchAll('/api/products?limit=200');
  const products: MetadataRoute.Sitemap = (productsRes?.products || []).map((p: any) => ({
    url: `${BASE}/product/${p.slug}`,
    lastModified: new Date(p.published_at || p.created_at),
    changeFrequency: 'weekly' as const,
    priority: 0.8,
  }));

  // Sellers dinamicos
  const sellersRes: any = await fetchAll('/api/sellers?limit=200');
  const sellers: MetadataRoute.Sitemap = (sellersRes?.sellers || []).map((s: any) => ({
    url: `${BASE}/seller/${s.store_slug}`,
    lastModified: new Date(s.updated_at || s.created_at),
    changeFrequency: 'weekly' as const,
    priority: 0.6,
  }));

  return [...staticPages, ...products, ...sellers];
}
