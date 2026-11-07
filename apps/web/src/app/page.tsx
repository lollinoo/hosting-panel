import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/server-session";

export default async function HomePage() {
  const session = await getServerSession();

  if (!session) {
    redirect("/login");
  }

  if (session.activeConsole === "infra") {
    redirect("/admin/hosts");
  } else if (session.activeConsole === "hosting") {
    redirect("/hosting/allocations");
  } else if (session.activeConsole === "org" && session.activeOrgSlug) {
    redirect(`/o/${session.activeOrgSlug}/overview`);
  }

  redirect("/choose-context");
}
