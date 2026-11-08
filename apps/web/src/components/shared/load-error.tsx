import type { Messages } from "@/i18n";

/** Shown when the panel could not load data: says what happened and what to do next. */
export function LoadError({ m }: { m: Messages }) {
  return (
    <div role="alert" className="mx-auto max-w-md rounded-xl border bg-card p-8 text-center shadow-sm">
      <h1 className="text-lg font-semibold">{m.shell.loadErrorTitle}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{m.shell.loadErrorBody}</p>
    </div>
  );
}
