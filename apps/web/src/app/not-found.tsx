import Link from "next/link";
import { Button } from "@/components/ui/button";
import { getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";

export default async function NotFoundPage() {
  const t = getMessages(await getRequestLocale()).notFound;
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-background px-4 text-center">
      <div className="max-w-md rounded-xl border bg-card p-8 shadow-sm">
        <p className="text-xs font-bold tracking-wider text-primary uppercase">{t.code}</p>
        <h1 className="mt-2 text-xl font-bold tracking-tight text-card-foreground">{t.title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t.body}</p>
        <div className="mt-6 flex justify-center gap-3">
          <Button asChild size="sm">
            <Link href="/">{t.back}</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
