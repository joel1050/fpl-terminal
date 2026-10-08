import type { Metadata } from "next";
import { IBM_Plex_Mono, Geist } from "next/font/google";
import "./globals.css";
import "./ui.css";

const mono = IBM_Plex_Mono({ weight: ["400", "500", "600", "700"], subsets: ["latin"], variable: "--font-mono", display: "swap" });
const prose = Geist({ subsets: ["latin"], variable: "--font-prose", display: "swap" });

const FALLBACK_ORIGIN = "http://localhost:3000";
const configuredOrigin = process.env.NEXT_PUBLIC_SITE_URL
  ?? process.env.SITE_URL
  ?? process.env.VERCEL_PROJECT_PRODUCTION_URL
  ?? process.env.VERCEL_URL;

function resolveOrigin(value: string | undefined): URL {
  const candidate = value?.trim() || FALLBACK_ORIGIN;
  try {
    return new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
  } catch {
    return new URL(FALLBACK_ORIGIN);
  }
}

const metadataOrigin = resolveOrigin(configuredOrigin);
const commitSha = process.env.VERCEL_GIT_COMMIT_SHA?.trim();
const buildId = commitSha ? commitSha.slice(0, 7) : "local";

export const metadata: Metadata = {
  metadataBase: metadataOrigin,
  title: "FPL Terminal",
  description: "Quantitative Fantasy Premier League squad intelligence.",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "FPL Terminal",
    title: "FPL Terminal",
    description: "Quantitative Fantasy Premier League squad intelligence.",
  },
  twitter: {
    card: "summary",
    title: "FPL Terminal",
    description: "Quantitative Fantasy Premier League squad intelligence.",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${mono.variable} ${prose.variable}`}>
      <body>
        {children}
        <span className="build-stamp" data-testid="build-stamp" title={commitSha ? `Deployment commit ${commitSha}` : "Local development build"}>
          BUILD {buildId}
        </span>
      </body>
    </html>
  );
}
