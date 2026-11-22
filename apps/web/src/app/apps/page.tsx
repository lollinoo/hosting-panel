import Link from "next/link";
import { AppStackList } from "@/components/app-stacks/app-stack-list";
import { AppsUnavailable, appsGate } from "@/components/app-stacks/apps-unavailable";
import { LoadError } from "@/components/shared/load-error";
import { Button } from "@/components/ui/button";
import { getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { fetchServerOrgAppStacks } from "@/lib/server-api";
import { getCustomerContext } from "@/app/sites/data";

export default async function AppsPage() {
  const ctx = await getCustomerContext();
  const locale = await getRequestLocale();
  const m = getMessages(locale);
  const gate = appsGate(ctx);
  if (gate) return <AppsUnavailable m={m} reason={gate} />;
  if (!ctx.orgId) return <LoadError m={m} />;
  const r = await fetchServerOrgAppStacks(ctx.orgId);
  if (!r.ok) return r.code === "NOT_SUPPORTED" ? <AppsUnavailable m={m} reason="off" /> : <LoadError m={m} />;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">{m.apps.list.title}</h1>
        <Button asChild>
          <Link href="/apps/new">{m.apps.list.create}</Link>
        </Button>
      </div>
      <AppStackList stacks={r.data} m={m} locale={locale} />
    </div>
  );
}
