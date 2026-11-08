import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/server-session";

export default async function HomePage() {
  const session = await getServerSession();

  if (!session) {
    redirect("/login");
  }

  if (session.activeConsole === "admin") {
    redirect("/admin/hosts");
  } else if (session.activeOrgSlug) {
    redirect(`/o/${session.activeOrgSlug}/overview`);
  }

  // A customer without an organization has nowhere to go; redirecting to "/" would loop.
  redirect("/login");
}
