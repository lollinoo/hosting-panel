import Link from "next/link";
import { AppStackList } from "@/components/app-stacks/app-stack-list";
import { appsGate } from "@/components/app-stacks/apps-unavailable";
import { LoadError } from "@/components/shared/load-error";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { getAppStacks, getSiteAddresses } from "@/lib/customer-reads";
import { getCustomerContext, getSites } from "@/app/sites/data";

export default async function AppsPage() {
  const ctx = await getCustomerContext();
  const locale = await getRequestLocale();
  const m = getMessages(locale);
  if (ctx.loadError || !ctx.orgId) return <LoadError m={m} />;
  const [sites, r, siteAddresses] = await Promise.all([
    getSites(ctx.orgId),
    appsGate(ctx) === null ? getAppStacks(ctx.orgId) : null,
    getSiteAddresses(ctx.orgId),
  ]);
  if (sites === null && !r?.ok) return <LoadError m={m} />;
  const stacks = r?.ok ? r.data : [];
  const partial = sites === null || (r !== null && !r.ok && r.code !== "NOT_SUPPORTED");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">{m.apps.list.title}</h1>
        <Button asChild>
          <Link href="/apps/new">{m.apps.list.create}</Link>
        </Button>
      </div>
      {partial && (
        <Alert variant="warning" role="alert">
          <AlertDescription>{m.apps.list.partial}</AlertDescription>
        </Alert>
      )}
      {!(partial && (sites ?? []).length + stacks.length === 0) && (
        <AppStackList stacks={stacks} sites={sites ?? []} siteAddresses={siteAddresses} m={m} locale={locale} />
      )}
    </div>
  );
}
