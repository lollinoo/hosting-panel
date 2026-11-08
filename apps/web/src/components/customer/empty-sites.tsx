import Link from "next/link";
import type { Messages } from "@/i18n";

export function EmptySites({ m }: { m: Messages }) {
  return (
    <div className="mx-auto max-w-md rounded-xl border bg-card p-8 text-center shadow-sm">
      <h1 className="text-lg font-semibold">{m.shell.emptyTitle}</h1>
      <Link
        href="/sites/new"
        className="mt-4 inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        {m.shell.emptyCta}
      </Link>
      <p className="mt-4 text-sm text-muted-foreground">{m.shell.emptyBody}</p>
    </div>
  );
}
