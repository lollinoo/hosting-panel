import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hosting Control Panel — Docker-Native Fase 1",
  description:
    "Piattaforma di controllo hosting Docker-native isolata con garanzie di multi-tenancy e sicurezza Fase 1 (HCP-SPEC-002)",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="it" className="h-full">
      <body className="min-h-full flex flex-col antialiased bg-background text-foreground">
        {children}
      </body>
    </html>
  );
}
