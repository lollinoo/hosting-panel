import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { Providers } from "@/components/providers";

export const metadata: Metadata = {
  title: "Hosting Control Panel — Gestione Cloud Multi-Tenant",
  description:
    "Pannello di controllo hosting multi-tenant con isolamento organizzazioni, operazioni asincrone verificate e sicurezza BFF.",
};

export default function RootLayout({
  children,
}: {
  readonly children: ReactNode;
}) {
  return (
    <html lang="it">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
