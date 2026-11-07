import { ShieldCheck } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ChooseOrgList } from "@/components/choose-org-list";
import { LogoutButton } from "@/components/logout-button";
import { fetchMe } from "@/lib/bff-client";
import { readServerSession } from "@/lib/server-session";

export const dynamic = "force-dynamic";

export default async function ChooseOrganizationPage() {
  const session = await readServerSession();
  if (!session) {
    redirect("/login");
  }

  const meRes = await fetchMe(session.accessToken);
  if (!meRes.ok) {
    redirect("/login");
  }

  const me = meRes.data.data;

  return (
    <main className="mx-auto max-w-4xl px-4 py-12">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            Scegli l&apos;organizzazione da gestire
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Autenticato come <strong>{me.user.displayName}</strong> ({me.user.email})
          </p>
        </div>
        <div className="flex items-center gap-3">
          {me.user.isPlatformAdmin && (
            <Link
              href="/admin/overview"
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800"
            >
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              Console Admin Piattaforma
            </Link>
          )}
          <div className="w-44">
            <LogoutButton csrfToken={session.csrfToken} />
          </div>
        </div>
      </div>

      <div className="mt-8">
        {me.memberships.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600">
            Il tuo profilo non appartiene al momento ad alcuna organizzazione cliente
            attiva.
          </div>
        ) : (
          <ChooseOrgList
            memberships={me.memberships}
            csrfToken={session.csrfToken}
          />
        )}
      </div>
    </main>
  );
}
