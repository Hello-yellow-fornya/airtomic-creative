import "./globals.css";
import Link from "next/link";
import type { ReactNode } from "react";

export const metadata = { title: "airtomic-creative" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <Link href="/" className="brand">
            airtomic<span>·creative</span>
          </Link>
          <nav>
            <Link href="/">Videos</Link>
            <Link href="/clips">Clips</Link>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
