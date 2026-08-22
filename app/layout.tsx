import type { Metadata } from "next";
import { IBM_Plex_Mono, Geist } from "next/font/google";
import "./globals.css";

const mono = IBM_Plex_Mono({ weight: ["400", "500", "600", "700"], subsets: ["latin"], variable: "--font-mono", display: "swap" });
const prose = Geist({ subsets: ["latin"], variable: "--font-prose", display: "swap" });

export const metadata: Metadata = {
  title: "FPL Terminal",
  description: "Quantitative Fantasy Premier League squad intelligence.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${mono.variable} ${prose.variable}`}>
      <body>{children}</body>
    </html>
  );
}
