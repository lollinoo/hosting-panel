import { appsGate } from "@/components/app-stacks/apps-unavailable";
import { appEntries, appLinks } from "@/components/app-stacks/app-stack-view";
import { CustomerTopBar } from "@/components/customer/top-bar";
import { SupportBanner } from "@/components/customer/support-banner";
import { LoadError } from "@/components/shared/load-error";
import { getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { getAppStacks } from "@/lib/customer-reads";
import { getCustomerContext, getSites } from "./data";

/** The customer console around /sites and /apps. A failed list read only leaves that kind out of the switcher: each page reads and reports its own data. */
export async function CustomerLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getCustomerContext();
  const locale = await getRequestLocale();
  const m = getMessages(locale);
  const [sites, stacks] = ctx.loadError
    ? [null, null]
    : await Promise.all([getSites(ctx.orgId), ctx.orgId !== null && appsGate(ctx) === null ? getAppStacks(ctx.orgId) : null]);
  const apps = appLinks(m, appEntries(sites ?? [], stacks?.ok ? stacks.data : [], locale));
  return (
    <div className="flex min-h-screen flex-col bg-muted/30">
      <CustomerTopBar apps={apps} userName={ctx.session.user.name} csrfToken={ctx.session.csrfToken} />
      {ctx.support && <SupportBanner support={ctx.support} csrfToken={ctx.session.csrfToken} />}
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">{ctx.loadError ? <LoadError m={m} /> : children}</main>
    </div>
  );
}
