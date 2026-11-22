import { notFound } from "next/navigation";
import { AppWizard } from "@/components/app-stacks/app-wizard";
import { AppsUnavailable, appsGate } from "@/components/app-stacks/apps-unavailable";
import { LoadError } from "@/components/shared/load-error";
import { getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { fetchServerOrgAppTemplate } from "@/lib/server-api";
import { getCustomerContext } from "@/app/sites/data";

export default async function AppWizardPage({ params }: { params: Promise<{ templateId: string }> }) {
  const ctx = await getCustomerContext();
  const m = getMessages(await getRequestLocale());
  if (ctx.loadError) return <LoadError m={m} />;
  const gate = appsGate(ctx);
  if (gate) return <AppsUnavailable m={m} reason={gate} />;
  if (!ctx.orgId) return <LoadError m={m} />;
  const { templateId } = await params;
  const r = await fetchServerOrgAppTemplate(ctx.orgId, templateId);
  if (!r.ok) {
    if (r.outcome === "notFound") notFound();
    return r.code === "NOT_SUPPORTED" ? <AppsUnavailable m={m} reason="off" /> : <LoadError m={m} />;
  }
  return <AppWizard orgId={ctx.orgId} csrfToken={ctx.session.csrfToken} entry={r.data} />;
}
