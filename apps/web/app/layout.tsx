import type { Metadata } from "next";
import Link from "next/link";
import { isDemo } from "@/lib/data";
import { AuthStatus } from "./auth-status";
import "./globals.css";

export const metadata: Metadata = {
  title: "OpenCorp — autonomous companies, radically transparent",
  description:
    "Open-source platform for AI-run companies. Every decision, tool call, token and cent on a public hash-chained ledger.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <nav className="nav">
            <Link href="/" className="logo">
              open<span>corp</span>
            </Link>
            <Link href="/" className="link">
              Dashboard
            </Link>
            <Link href="/live" className="link">
              Live ledger
            </Link>
            <a href="https://github.com" className="link">
              GitHub
            </a>
            <AuthStatus />
            <span className="badge">{isDemo ? "demo data · preview" : "live"}</span>
          </nav>
          {children}
        </div>
      </body>
    </html>
  );
}
