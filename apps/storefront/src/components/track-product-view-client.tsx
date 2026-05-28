'use client';

import { useEffect } from 'react';
import { trackProductView } from './recently-viewed-guest';

/**
 * MLB-14 WORKER 16 pass 131: Client component que dispara trackProductView
 * em useEffect on mount. Recebe product props do PDP (server component).
 *
 * Por que componente separado:
 * - PDP page eh server component (async + Promise<params>)
 * - useEffect/localStorage so funcionam em client component
 * - Wrapper minimo (renderiza null) - so triggers tracking side-effect
 */
export function TrackProductViewClient({ product }: {
  product: {
    slug: string;
    title: string;
    cover_image_url?: string | null;
    price_cents: number;
    is_free?: boolean;
  };
}) {
  useEffect(() => {
    trackProductView({
      slug: product.slug,
      title: product.title,
      cover_image_url: product.cover_image_url || null,
      price_cents: product.price_cents,
      is_free: product.is_free,
    });
  }, [product.slug, product.title, product.cover_image_url, product.price_cents, product.is_free]);

  return null;
}
