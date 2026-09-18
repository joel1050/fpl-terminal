import type { NextConfig } from "next";

const historicalDataRoutes = [
  "/api/fpl/bootstrap",
  "/api/best-xi",
  "/api/chip-suggestions",
  "/api/optimizer",
  "/api/transfer-suggestions",
] as const;

const generatedData = ["data/generated/*.json"];
const nonRuntimeTraceFiles = [
  "./.claude/**/*",
  "./.playwright-cli/**/*",
  "./agent_docs/**/*",
  "./data/snapshots/**/*",
  "./docs/**/*",
  "./graphify-out/**/*",
  "./lib/graphify-out/**/*",
  "./output/**/*",
  "./plans/**/*",
  "./playwright-report/**/*",
  "./scripts/**/*",
  "./test-results/**/*",
  "./tests/**/*",
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["highs"],
  outputFileTracingIncludes: Object.fromEntries(
    historicalDataRoutes.map((route) => [route, generatedData]),
  ),
  outputFileTracingExcludes: Object.fromEntries(
    historicalDataRoutes.map((route) => [route, nonRuntimeTraceFiles]),
  ),
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
