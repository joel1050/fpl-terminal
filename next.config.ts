import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["highs"],
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
