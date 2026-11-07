import { CapabilityNotice } from "@/components/capability-notice";
import { fetchOrganizationMembers } from "@/lib/bff-client";
import { formatDateTimeIt, formatRoleLabelIt } from "@/lib/format";
import { resolveOrgServerContext } from "@/lib/org-context";

export const dynamic = "force-dynamic";

export interface MembersPageProps {
  readonly params: Promise<{ readonly orgSlug: string }>;
}

export default async function OrganizationMembersPage({
  params,
}: MembersPageProps) {
  const { orgSlug } = await params;
  const { session, membership } = await resolveOrgServerContext(orgSlug);

  const membersRes = await fetchOrganizationMembers(
    session.accessToken,
    membership.organizationId,
  );

  if (!membersRes.ok) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-slate-900">Membri Organizzazione</h1>
        <CapabilityNotice
          tone="warning"
          title="Elenco membri non accessibile"
          description={membersRes.error.error.message}
        />
      </div>
    );
  }

  const members = membersRes.data.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">
          Membri &amp; Ruoli — {membership.organizationName}
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Utenti attivi nell&apos;organizzazione e ruoli predefiniti assegnati con
          protezione dell&apos;ultimo titolare (AC-022).
        </p>
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xs">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-semibold tracking-wider text-slate-500 uppercase">
              <tr>
                <th className="px-4 py-3">Nome Utente</th>
                <th className="px-4 py-3">Indirizzo Email</th>
                <th className="px-4 py-3">Ruoli Assegnati</th>
                <th className="px-4 py-3">Membro dal</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {members.map((member) => (
                <tr key={member.membershipId} className="hover:bg-slate-50/70">
                  <td className="px-4 py-3.5 font-semibold text-slate-900">
                    {member.displayName}
                  </td>
                  <td className="px-4 py-3.5 text-slate-600">{member.email}</td>
                  <td className="px-4 py-3.5">
                    <div className="flex flex-wrap gap-1.5">
                      {member.roles.map((role) => (
                        <span
                          key={role}
                          className="inline-flex items-center rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-medium text-indigo-800 ring-1 ring-inset ring-indigo-600/20"
                        >
                          {formatRoleLabelIt(role)}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3.5 text-xs text-slate-600">
                    {formatDateTimeIt(member.joinedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
