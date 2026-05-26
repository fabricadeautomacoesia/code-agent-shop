/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  poweredByHeader: false,
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  async rewrites() {
    const gw = process.env.GATEWAY_URL || 'http://127.0.0.1:3002';
    return [{ source: '/api/:path*', destination: `${gw}/api/:path*` }];
  },
};
