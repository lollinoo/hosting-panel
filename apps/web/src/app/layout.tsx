import type { Metadata } from "next";
import "./globals.css";
import { getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { I18nProvider } from "@/i18n/provider";

export const metadata: Metadata = {
  title: "Hosting Panel",
  description:
    "Gestisci i tuoi siti e il tuo hosting in un unico posto.",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = await getRequestLocale();
  return (
    <html lang={locale} className="h-full">
      <body className="min-h-full flex flex-col antialiased bg-background text-foreground">
        <I18nProvider locale={locale} messages={getMessages(locale)}>
          {children}
        </I18nProvider>
      </body>
    </html>
  );
}
