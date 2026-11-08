import { notFound } from "next/navigation";
import { getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { StatusPill } from "@/components/customer/status-pill";
import { SiteTabs } from "@/components/customer/site-tabs";
import { LoadError } from "@/components/shared/load-error";
import { getCustomerContext, getSite } from "../data";

export default async function SiteLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ siteId: string }>;
}) {
  const { siteId } = await params;
  const { orgId, loadError } = await getCustomerContext();
  if (loadError) return null; // the sites layout already shows the load error
  const result = await getSite(orgId, siteId);
  const m = getMessages(await getRequestLocale());
  if (!result.ok) {
    // Only a real 404 is "page not found"; any other failure says "try again".
    if (result.outcome === "notFound") notFound();
    return <LoadError m={m} />;
  }
  const site = result.data;
  const primary = site.domains.find((d) => d.isPrimary) ?? site.domains[0];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{site.name}</h1>
        <StatusPill status={site.status} driftSummary={site.driftSummary} labels={m.site.status} />
        {site.phpVersion !== null && site.status === "ready" && primary && (
          <a
            href={`http://${primary.hostname}/wp-admin/`}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            {m.site.wpAdmin} <span aria-hidden>&nbsp;↗</span>
            <span className="sr-only"> {m.site.opensNewTab}</span>
          </a>
        )}
        {primary && (
          <a
            href={`https://${primary.hostname}`}
            target="_blank"
            rel="noopener noreferrer"
            className={`${site.phpVersion !== null && site.status === "ready" ? "" : "ml-auto "}text-sm font-medium text-primary underline-offset-4 hover:underline`}
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
