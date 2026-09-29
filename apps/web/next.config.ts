import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  async rewrites() {
    return [{
      source: '/v1/:path*',
      destination: `${process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:3001'}/v1/:path*`,
    }];
  },
};

export default nextConfig;
