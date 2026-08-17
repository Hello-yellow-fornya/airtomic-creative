import "./globals.css";
import { Archivo, Inter, JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";
import Rail from "./Rail";

const archivo = Archivo({
  subsets: ["latin"], weight: ["500", "600", "700"], variable: "--font-archivo",
});
const inter = Inter({
  subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-inter",
});
const mono = JetBrains_Mono({
  subsets: ["latin"], weight: ["400", "500", "700"], variable: "--font-mono",
});

export const metadata = { title: "Creative Builder · Klira" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className={`${archivo.variable} ${inter.variable} ${mono.variable}`}>
        <div className="app">
          <Rail />
          <div className="main">{children}</div>
        </div>
      </body>
    </html>
  );
}
