import Link from "next/link";
import { Button } from "@/components/ui/button";
import { getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";

// Renders inside the apps layout (its <main> and the support banner); the root page would drop both.
export default async function AppsNotFound() {
  const t = getMessages(await getRequestLocale()).apps.notFound;
  return (
    <div className="mx-auto max-w-md rounded-xl border bg-card p-8 text-center shadow-sm">
      <h1 className="text-xl font-bold tracking-tight text-card-foreground">{t.title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{t.body}</p>
      <div className="mt-6 flex justify-center gap-3">
        <Button asChild size="sm">
          <Link href="/apps">{t.back}</Link>
        </Button>
      </div>
    </div>
  );
}
