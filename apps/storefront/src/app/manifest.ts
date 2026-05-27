import type { MetadataRoute } from 'next';

/**
 * Web App Manifest (PWA + favicon/theme).
 * Permite "Install app" no Chrome mobile + theme color na omnibar.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Code & Agent Shop',
    short_name: 'CAS',
    description: 'Marketplace de automacoes, agentes de IA, workflows n8n e scripts.',
    start_url: '/',
    display: 'standalone',
    background_color: '#0A0F1C',
    theme_color: '#EC4899',
    lang: 'pt-BR',
    orientation: 'portrait-primary',
    categories: ['shopping', 'business', 'productivity'],
    icons: [
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
    ],
  };
}
