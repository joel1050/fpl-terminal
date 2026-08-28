import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["highs"],
  outputFileTracingIncludes: {
    "/api/fpl/bootstrap": ["data/generated/*.json"],
  },
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
