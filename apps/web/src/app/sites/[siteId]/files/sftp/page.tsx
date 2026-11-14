import Link from "next/link";
import type { SiteSftpDto } from "@hosting-panel/contracts";
import { getCustomerContext, getSite } from "@/app/sites/data";
import { SftpAccess } from "@/components/customer/sftp-access";
import { LoadError } from "@/components/shared/load-error";
import { getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { serverGet } from "@/lib/server-api";

export default async function SiteSftpPage({
  params,
}: {
  params: Promise<{ siteId: string }>;
}) {
  const { siteId } = await params;
  const { orgId, session } = await getCustomerContext();
  const result = await getSite(orgId, siteId);
  if (!result.ok || !session || !orgId) return null;

  const m = getMessages(await getRequestLocale());
  const sftpRes = await serverGet<SiteSftpDto>(
    `v1/organizations/${encodeURIComponent(orgId)}/managed-sites/${encodeURIComponent(result.data.id)}/sftp`,
    { timeoutMs: 20_000 },
  );
  if (!sftpRes.ok && sftpRes.status !== 403) {
    return <LoadError m={m} />;
  }

  const t = m.site.files.sftp;
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link
          href={`/sites/${result.data.id}/files`}
          className="inline-flex text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          {t.back}
        </Link>
        <h2 className="text-lg font-semibold">{t.title}</h2>
      </div>
      {sftpRes.ok ? (
        <SftpAccess
          basePath={`/api/bff/orgs/${orgId}/managed-sites/${result.data.id}/sftp`}
          csrfToken={session.csrfToken}
          initial={sftpRes.data}
        />
      ) : (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive"
        >
          {sftpRes.code === "ORGANIZATION_SUSPENDED"
            ? t.errors.ORGANIZATION_SUSPENDED
            : m.errors.PERMISSION_DENIED}
        </p>
      )}
    </div>
  );
}
