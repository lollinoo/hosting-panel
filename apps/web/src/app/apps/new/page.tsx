import { redirect } from "next/navigation";
import { AppCatalog } from "@/components/app-stacks/app-catalog";
import { appsGate } from "@/components/app-stacks/apps-unavailable";
import { SiteTypeCards } from "@/components/customer/site-type-cards";
import { LoadError } from "@/components/shared/load-error";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { optional, siteLimitOf } from "@/lib/customer-reads";
import { fetchServerCustomerSiteTypes, fetchServerOrg, fetchServerOrgAppTemplates } from "@/lib/server-api";
import { getCustomerContext } from "@/app/sites/data";

export default async function NewAppPage() {
  const ctx = await getCustomerContext();
  const m = getMessages(await getRequestLocale());
  if (ctx.loadError || !ctx.orgId) return <LoadError m={m} />;
  // A support visit offers WordPress only: the form skips the customer's own reads.
  if (ctx.support !== null) redirect("/sites/new");
  const [types, org, catalog] = await Promise.all([
    optional(fetchServerCustomerSiteTypes(ctx.orgId)),
    optional(fetchServerOrg(ctx.orgId)),
    appsGate(ctx) === null ? fetchServerOrgAppTemplates(ctx.orgId) : null,
  ]);
  // Unreadable types (a malformed body too) leave one generic WordPress choice: the form then posts the legacy body.
  const wordpress = types?.siteTypes ?? [null];
  const templates = catalog?.ok ? catalog.data.templates : [];
  const catalogFailed = catalog !== null && !catalog.ok && catalog.code !== "NOT_SUPPORTED";
  if (templates.length === 0 && !catalogFailed && wordpress.length <= 1) redirect("/sites/new");

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">{m.apps.catalog.title}</h1>
      {catalogFailed && (
        <Alert variant="warning" role="alert">
          <AlertDescription>{m.apps.list.partial}</AlertDescription>
        </Alert>
      )}
      {wordpress.length > 0 && <SiteTypeCards m={m} types={wordpress} limit={siteLimitOf(org)} />}
      {catalog?.ok && templates.length > 0 && <AppCatalog entries={templates} categories={catalog.data.categories} />}
    </div>
  );
}
