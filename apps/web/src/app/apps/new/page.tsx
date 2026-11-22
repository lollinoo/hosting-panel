import { AppCatalog } from "@/components/app-stacks/app-catalog";
import { AppsUnavailable, appsGate } from "@/components/app-stacks/apps-unavailable";
import { LoadError } from "@/components/shared/load-error";
import { getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { fetchServerOrgAppTemplates } from "@/lib/server-api";
import { getCustomerContext } from "@/app/sites/data";

export default async function NewAppPage() {
  const ctx = await getCustomerContext();
  const m = getMessages(await getRequestLocale());
  const gate = appsGate(ctx);
  if (gate) return <AppsUnavailable m={m} reason={gate} />;
  if (!ctx.orgId) return <LoadError m={m} />;
  const r = await fetchServerOrgAppTemplates(ctx.orgId);
  if (!r.ok) return r.code === "NOT_SUPPORTED" ? <AppsUnavailable m={m} reason="off" /> : <LoadError m={m} />;
  return <AppCatalog entries={r.data.templates} categories={r.data.categories} />;
}
