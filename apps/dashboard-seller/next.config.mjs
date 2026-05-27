/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  poweredByHeader: false,
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  async rewrites() {
    // FIX-WORKER-7 pass 2: rewrites congelam no build (.next/routes-manifest.json)
    // com fallback 127.0.0.1:3002 (ECONNREFUSED em Swarm). Trocar para DNS service
    // alias 'gateway' da rede 'minha_rede' Swarm garante resilencia mesmo sem
    // GATEWAY_URL no build. Mesmo bug ja corrigido em storefront (W7 pass 1).
    const gw = process.env.GATEWAY_URL || 'http://gateway:3002';
    return [{ source: '/api/:path*', destination: `${gw}/api/:path*` }];
  },
};
