import { notFound } from "next/navigation";
import { getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { StatusPill } from "@/components/customer/status-pill";
import { SiteTabs } from "@/components/customer/site-tabs";
import { getCustomerContext, getSite } from "../data";

export default async function SiteLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ siteId: string }>;
}) {
  const { siteId } = await params;
  const { orgId } = await getCustomerContext();
  const site = await getSite(orgId, siteId);
  if (!site) notFound();

  const m = getMessages(await getRequestLocale());
  const primary = site.domains.find((d) => d.isPrimary) ?? site.domains[0];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{site.name}</h1>
        <StatusPill status={site.status} driftSummary={site.driftSummary} labels={m.site.status} />
        {primary && (
          <a
            href={`https://${primary.hostname}`}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            {m.site.visit} <span aria-hidden>↗</span>
            <span className="sr-only"> {m.site.opensNewTab}</span>
          </a>
        )}
      </div>
      <SiteTabs siteId={site.id} />
      {children}
    </div>
  );
}
