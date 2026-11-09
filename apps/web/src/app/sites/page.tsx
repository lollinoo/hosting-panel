import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { EmptySites } from "@/components/customer/empty-sites";
import { getCustomerContext, getSites } from "./data";
import { LAST_SITE_COOKIE, pickLandingSite } from "./landing";

export default async function SitesPage() {
  const { orgId } = await getCustomerContext();
  const sites = await getSites(orgId);
  if (!sites) return null; // the layout already shows the load error
  const target = pickLandingSite(sites, (await cookies()).get(LAST_SITE_COOKIE)?.value);
  if (target) redirect(`/sites/${target}`);

  const m = getMessages(await getRequestLocale());
  return (
    <EmptySites m={m} />
  );
}
