/**
 * Server component que renderiza schema.org JSON-LD para SEO rich snippets.
 * Google exibe estrelas, preco, disponibilidade direto no SERP.
 */
export function JsonLd({ data }: { data: Record<string, any> | Record<string, any>[] }) {
  return (
    <script
      type="application/ld+json"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}

const SITE_URL = 'https://cas.inovareinteligenciaartificial.com';

export function productLd(product: any, reviews: any[] = []) {
  const url = `${SITE_URL}/product/${product.slug}`;
  const aggRating = product.avg_rating && product.review_count > 0 ? {
    '@type': 'AggregateRating',
    ratingValue: Number(product.avg_rating).toFixed(1),
    reviewCount: product.review_count,
    bestRating: '5',
    worstRating: '1',
  } : undefined;

  return {
    '@context': 'https://schema.org/',
    '@type': 'Product',
    name: product.title,
    description: (product.short_description || product.description || '').replace(/<[^>]+>/g, '').slice(0, 500),
    image: product.cover_image_url || undefined,
    sku: product.id,
    brand: {
      '@type': 'Brand',
      name: product.is_platform_owned ? 'Code & Agent Shop (Oficial)' : (product.store_name || 'Marketplace CAS'),
    },
    category: product.category_name || undefined,
    offers: {
      '@type': 'Offer',
      url,
      priceCurrency: product.currency || 'BRL',
      price: product.is_free ? '0.00' : (product.price_cents / 100).toFixed(2),
      availability: product.status === 'approved' ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      seller: {
        '@type': 'Organization',
        name: product.is_platform_owned ? 'Code & Agent Shop' : (product.store_name || 'Vendedor CAS'),
      },
    },
    aggregateRating: aggRating,
    review: reviews.slice(0, 5).map((r: any) => ({
      '@type': 'Review',
      author: { '@type': 'Person', name: r.buyer_name || 'Cliente CAS' },
      reviewRating: {
        '@type': 'Rating',
        ratingValue: r.rating,
        bestRating: '5',
        worstRating: '1',
      },
      reviewBody: r.body,
      name: r.title || undefined,
      datePublished: r.created_at,
    })).filter((r: any) => r.reviewBody),
  };
}

export function breadcrumbLd(product: any) {
  const items = [
    { name: 'Catalogo', url: `${SITE_URL}/products` },
  ];
  if (product.category_name && product.category_slug) {
    items.push({ name: product.category_name, url: `${SITE_URL}/categoria/${product.category_slug}` });
  }
  items.push({ name: product.title, url: `${SITE_URL}/product/${product.slug}` });

  return {
    '@context': 'https://schema.org/',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      item: it.url,
    })),
  };
}

export function organizationLd() {
  return {
    '@context': 'https://schema.org/',
    '@type': 'Organization',
    name: 'Code & Agent Shop',
    alternateName: 'CAS',
    url: SITE_URL,
    logo: `${SITE_URL}/logo.png`,
    sameAs: [
      'https://github.com/fabricadeautomacoesia',
    ],
    description: 'Marketplace de automacoes, agentes de IA, workflows n8n e scripts. QA automatizado via LLM.',
  };
}

export function webSiteLd() {
  return {
    '@context': 'https://schema.org/',
    '@type': 'WebSite',
    name: 'Code & Agent Shop',
    url: SITE_URL,
    // Sitelinks search box (Google rich result)
    potentialAction: {
      '@type': 'SearchAction',
      target: { '@type': 'EntryPoint', urlTemplate: `${SITE_URL}/products?q={search_term_string}` },
      'query-input': 'required name=search_term_string',
    },
  };
}
