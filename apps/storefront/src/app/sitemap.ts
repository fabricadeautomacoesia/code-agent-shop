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
  const now = new Date();

  // Paginas estaticas + landings (anteriormente ausentes do sitemap)
  const staticPages: MetadataRoute.Sitemap = [
    { url: BASE,                           lastModified: now, changeFrequency: 'daily',   priority: 1.0 },
    { url: `${BASE}/products`,             lastModified: now, changeFrequency: 'hourly',  priority: 0.9 },
    { url: `${BASE}/sellers`,              lastModified: now, changeFrequency: 'daily',   priority: 0.7 },
    { url: `${BASE}/promocoes`,            lastModified: now, changeFrequency: 'hourly',  priority: 0.85 },
    { url: `${BASE}/comparar`,             lastModified: now, changeFrequency: 'monthly', priority: 0.5 },
    { url: `${BASE}/cloud-code-ilimitado`, lastModified: now, changeFrequency: 'weekly',  priority: 0.75 },
    { url: `${BASE}/sobre`,                lastModified: now, changeFrequency: 'monthly', priority: 0.4 },
    { url: `${BASE}/termos`,               lastModified: now, changeFrequency: 'yearly',  priority: 0.2 },
    { url: `${BASE}/privacidade`,          lastModified: now, changeFrequency: 'yearly',  priority: 0.2 },
    { url: `${BASE}/status`,               lastModified: now, changeFrequency: 'always',  priority: 0.3 },
    { url: `${BASE}/login`,                lastModified: now, changeFrequency: 'monthly', priority: 0.3 },
    { url: `${BASE}/register`,             lastModified: now, changeFrequency: 'monthly', priority: 0.5 },
  ];

  // Categorias dinamicas (paginas /categoria/[slug])
  const catsRes: any = await fetchAll('/api/search/categories');
  const catSlugs: string[] = (catsRes?.categories || catsRes || [])
    .map((c: any) => c?.slug)
    .filter(Boolean);
  const categories: MetadataRoute.Sitemap = catSlugs.map((slug) => ({
    url: `${BASE}/categoria/${slug}`,
    lastModified: now,
    changeFrequency: 'daily' as const,
    priority: 0.75,
  }));

  // Filtros populares por kind (deep-link facets em /products)
  const kinds = ['ai_agent', 'n8n_workflow', 'automation', 'script', 'template', 'dataset', 'prompt_pack'];
  const kindPages: MetadataRoute.Sitemap = kinds.map((k) => ({
    url: `${BASE}/products?kind=${k}`,
    lastModified: now,
    changeFrequency: 'daily' as const,
    priority: 0.6,
  }));

  // Produtos dinamicos
  const productsRes: any = await fetchAll('/api/products?limit=500');
  const products: MetadataRoute.Sitemap = (productsRes?.products || []).map((p: any) => ({
    url: `${BASE}/product/${p.slug}`,
    lastModified: new Date(p.updated_at || p.published_at || p.created_at),
    changeFrequency: 'weekly' as const,
    priority: 0.8,
  }));

  // Sellers dinamicos
  const sellersRes: any = await fetchAll('/api/sellers?limit=500');
  const sellers: MetadataRoute.Sitemap = (sellersRes?.sellers || []).map((s: any) => ({
    url: `${BASE}/seller/${s.store_slug}`,
    lastModified: new Date(s.updated_at || s.created_at),
    changeFrequency: 'weekly' as const,
    priority: 0.6,
  }));

  return [...staticPages, ...categories, ...kindPages, ...products, ...sellers];
}
