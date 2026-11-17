import { SiteLogs } from "@/components/customer/site-logs";
import { getCustomerContext, getSite } from "../../data";

export default async function SiteLogsPage({ params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  const { orgId } = await getCustomerContext();
  const result = await getSite(orgId, siteId);
  if (!result.ok || !orgId) return null; // the layout shows the 404 or the load error
  return <SiteLogs url={`/api/bff/orgs/${orgId}/managed-sites/${result.data.id}/logs?tail=200`} />;
}
