import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { getCustomerContext, getSites } from "./data";
import { LAST_SITE_COOKIE, pickLandingSite } from "./landing";

export default async function SitesPage() {
  const { orgId } = await getCustomerContext();
  const sites = await getSites(orgId);
  const target = pickLandingSite(sites, (await cookies()).get(LAST_SITE_COOKIE)?.value);
  if (target) redirect(`/sites/${target}`);

  const m = getMessages(await getRequestLocale());
  return (
    <div className="mx-auto max-w-md rounded-xl border bg-card p-8 text-center shadow-sm">
      <h1 className="text-lg font-semibold">{m.shell.emptyTitle}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{m.shell.emptyBody}</p>
    </div>
  );
}
