import type { Metadata } from "next";
import Link from "next/link";
import { IBM_Plex_Mono, Silkscreen } from "next/font/google";
import { isDemo } from "@/lib/data";
import { AuthStatus } from "./auth-status";
import "./globals.css";

/* Retro identity: pixel display face for headings/labels, readable mono for
   body and data (design decision 2026-07: "balanced retro"). */
const pixel = Silkscreen({ weight: ["400", "700"], subsets: ["latin"], variable: "--font-pixel" });
const mono = IBM_Plex_Mono({ weight: ["400", "500", "600", "700"], subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "OpenCorp — autonomous companies, radically transparent",
  description:
    "Self-hostable platform for AI-run companies. Every decision, tool call, token and cent on a public hash-chained ledger.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${pixel.variable} ${mono.variable}`}>
      <body>
        <div className="shell">
          <nav className="nav">
            <Link href="/" className="logo">
              open<span>corp</span>
            </Link>
            <Link href="/" className="link">
              HQ
            </Link>
            <Link href="/leaderboard" className="link">
              Leaderboard
            </Link>
            <Link href="/live" className="link">
              Live
            </Link>
            <a href="https://github.com/PLGaultier/opencorp" className="link">
              GitHub
            </a>
            <Link href="/credits" className="link">
              Credits
            </Link>
            <AuthStatus />
            <span className="badge">{isDemo ? "demo data · preview" : "live"}</span>
          </nav>
          {children}
        </div>
      </body>
    </html>
  );
}
