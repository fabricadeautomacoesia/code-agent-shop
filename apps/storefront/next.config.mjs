/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**' },
      { protocol: 'http',  hostname: 'localhost' },
    ],
  },
  async rewrites() {
    const gw = process.env.GATEWAY_URL || 'http://127.0.0.1:3002';
    return [
      { source: '/api/:path*', destination: `${gw}/api/:path*` },
    ];
  },
  poweredByHeader: false,
  // V1 deploy: nao bloqueia build por erros TS/ESLint
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
