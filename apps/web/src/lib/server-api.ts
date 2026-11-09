import { redirect } from "next/navigation";
import { getServerSession } from "./server-session";
import { fetchUpstream } from "./upstream";
import type {
  HostDto,
  HostAllocationDto,
  ServiceTemplateDto,
  AuditEventDto,
  OrganizationDetailDto,
  ResourceQuotaDto,
  MemberDto,
  SiteSummaryDto,
  SiteDetailDto,
  OperationDto,
  MeDto,
  AdminUserDto,
  AdminSitesListDto,
  EncryptedSecretMetadataDto,
  HostTelemetryDto,
  HostDaemonHeartbeatDto,
  RuntimeBackend,
} from "@hosting-panel/contracts";

export interface HostTelemetryOverviewDto {
  hostId: string;
  runtimeBackend: RuntimeBackend;
  telemetry: HostTelemetryDto | null;
  daemons: HostDaemonHeartbeatDto[];
}

export type UpstreamOutcome = "ok" | "expired" | "notFound" | "error";

/** 401 = the API session is dead (revoked/expired); 404 = really missing; anything else = a failure to report. */
export function classifyUpstream(res: { ok: boolean; status: number }): UpstreamOutcome {
  if (res.ok) return "ok";
  if (res.status === 401) return "expired";
  return res.status === 404 ? "notFound" : "error";
}

export type ServerResult<T> = { ok: true; data: T } | { ok: false; outcome: "notFound" | "error" };

/**
 * GET for server components. A dead API session never renders misleading empty UI:
 * it goes through /api/session/expired, which clears the cookie and lands on /login.
 */
export async function serverGet<T>(path: string): Promise<ServerResult<T>> {
  const session = await getServerSession();
  if (!session) redirect("/login");
  const res = await fetchUpstream<{ data: T }>(path, { accessToken: session.accessToken });
  const outcome = classifyUpstream(res);
  if (outcome === "expired") redirect("/api/session/expired");
  if (outcome === "ok" && res.data?.data !== undefined) return { ok: true, data: res.data.data };
  return { ok: false, outcome: outcome === "notFound" ? "notFound" : "error" };
}

const orNull = <T>(r: ServerResult<T>): T | null => (r.ok ? r.data : null);
const orEmpty = <T>(r: ServerResult<T[]>): T[] => (r.ok ? r.data : []);

/** null = /v1/me failed for a reason other than a dead session (that one redirects to login). */
export async function fetchServerMe(): Promise<MeDto | null> {
  return orNull(await serverGet<MeDto>("v1/me"));
}

export async function fetchServerHosts(): Promise<HostDto[]> {
  return orEmpty(await serverGet<HostDto[]>("v1/hosts"));
}

export async function fetchServerHost(hostId: string): Promise<HostDto | null> {
  return orNull(await serverGet<HostDto>(`v1/hosts/${hostId}`));
}

export async function fetchServerHostAllocations(hostId: string): Promise<HostAllocationDto[]> {
  return orEmpty(await serverGet<HostAllocationDto[]>(`v1/hosts/${hostId}/allocations`));
}

export async function fetchServerAllocations(): Promise<HostAllocationDto[]> {
  return orEmpty(await serverGet<HostAllocationDto[]>("v1/allocations"));
}

export async function fetchServerTemplates(): Promise<ServiceTemplateDto[]> {
  return orEmpty(await serverGet<ServiceTemplateDto[]>("v1/service-templates"));
}

export async function fetchServerAudit(): Promise<AuditEventDto[]> {
  return orEmpty(await serverGet<AuditEventDto[]>("v1/admin/audit"));
}

export async function fetchServerOrg(orgId: string): Promise<OrganizationDetailDto | null> {
  return orNull(await serverGet<OrganizationDetailDto>(`v1/organizations/${orgId}`));
}

/** null = the list could not be loaded (not "no sites"). */
export async function fetchServerOrgSites(orgId: string): Promise<SiteSummaryDto[] | null> {
  return orNull(await serverGet<SiteSummaryDto[]>(`v1/organizations/${orgId}/sites`));
}

export async function fetchServerOrgSite(orgId: string, siteId: string): Promise<ServerResult<SiteDetailDto>> {
  return serverGet<SiteDetailDto>(`v1/organizations/${orgId}/sites/${siteId}`);
}

export async function fetchServerOrgQuotas(orgId: string): Promise<ResourceQuotaDto | null> {
  return orNull(await serverGet<ResourceQuotaDto>(`v1/organizations/${orgId}/quotas`));
}

export async function fetchServerOrgMembers(orgId: string): Promise<MemberDto[]> {
  return orEmpty(await serverGet<MemberDto[]>(`v1/organizations/${orgId}/members`));
}

/** null = the operations could not be loaded (not "nothing happened"). */
export async function fetchServerOrgOperations(orgId: string): Promise<OperationDto[] | null> {
  return orNull(await serverGet<OperationDto[]>(`v1/organizations/${orgId}/operations`));
}

export async function fetchServerOrgSecrets(
  orgId: string,
  siteId?: string
): Promise<EncryptedSecretMetadataDto[]> {
  const query = siteId ? `?siteId=${encodeURIComponent(siteId)}` : "";
  return orEmpty(await serverGet<EncryptedSecretMetadataDto[]>(`v1/organizations/${orgId}/secrets${query}`));
}

export async function fetchServerHostTelemetry(hostId: string): Promise<HostTelemetryOverviewDto | null> {
  return orNull(await serverGet<HostTelemetryOverviewDto>(`v1/hosts/${hostId}/telemetry`));
}

export async function fetchServerAdminUsers(): Promise<AdminUserDto[]> {
  return orEmpty(await serverGet<AdminUserDto[]>("v1/admin/users"));
}

export async function fetchServerAdminSites(): Promise<AdminSitesListDto | null> {
  return orNull(await serverGet<AdminSitesListDto>("v1/admin/sites"));
}
