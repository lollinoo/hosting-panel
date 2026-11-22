import { getCustomerContext } from "@/app/sites/data";
import { CustomerLayout } from "@/app/sites/customer-layout";

export const dynamic = "force-dynamic";

export default async function AppsLayout({ children }: { children: React.ReactNode }) {
  await getCustomerContext(); // the login, password and support guards run before anything renders (cached: CustomerLayout reuses it)
  // Called, not rendered as <CustomerLayout>: the awaited layout is then plain markup, with no async component left inside.
  return CustomerLayout({ children });
}
