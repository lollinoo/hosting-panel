import { redirect } from "next/navigation";
import { fetchMe } from "@/lib/bff-client";
import { readServerSession } from "@/lib/server-session";

export const dynamic = "force-dynamic";

export default async function HomeRedirectPage() {
  const session = await readServerSession();
  if (!session) {
    redirect("/login");
  }

  const meRes = await fetchMe(session.accessToken);
  if (!meRes.ok) {
    redirect("/login");
  }

  const me = meRes.data.data;

  if (session.activeOrgSlug) {
    const matched = me.memberships.find(
      (m) => m.organizationSlug === session.activeOrgSlug,
    );
    if (matched) {
      redirect(`/o/${matched.organizationSlug}/overview`);
    }
  }

  if (me.user.isPlatformAdmin && me.memberships.length === 0) {
    redirect("/admin/overview");
  }

  if (me.memberships.length === 1 && me.memberships[0]) {
    redirect(`/o/${me.memberships[0].organizationSlug}/overview`);
  }

  redirect("/choose-organization");
}
