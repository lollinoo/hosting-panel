import { redirect } from "next/navigation";
import { NewSite } from "@/components/customer/new-site";
import { getCustomerContext } from "../data";

export default async function NewSitePage() {
  const { session, orgId } = await getCustomerContext();
  if (!orgId) redirect("/sites");
  return <NewSite orgId={orgId} csrfToken={session.csrfToken} />;
}
