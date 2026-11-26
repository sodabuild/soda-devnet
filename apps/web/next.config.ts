import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The prototype is a single page.
  async redirects() {
    return [{ source: "/", destination: "/alpenglow", permanent: false }];
  },
  devIndicators: false,
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
