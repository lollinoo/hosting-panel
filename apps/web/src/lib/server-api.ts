import { redirect } from "next/navigation";
import { TLS_INVENTORY_FILTERS } from "@hosting-panel/contracts";
import { getServerSession } from "./server-session";
import { fetchUpstream } from "./upstream";
import { FIREWALL_BFF_TIMEOUT_MS } from "./admin-firewall";
import { isValidPathSegment } from "./bff-guard";
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
  SiteDomainsDto,
  OperationDto,
  MeDto,
  AdminUserDto,
  AdminSitesListDto,
  EncryptedSecretMetadataDto,
  HostTelemetryDto,
  HostDaemonHeartbeatDto,
  RuntimeBackend,
  MailRelaySettingsDto,
  NotificationSettingsDto,
  DnsProviderSettingsDto,
  BackupSettingsDto,
  AdminSiteBackupStatusDto,
  AdminHealthDto,
  AdminAlertDto,
  FirewallDto,
  UpdatesDto,
  OsPackagesDto,
  TlsCertificateDto,
  AdminTlsInventoryItemDto,
  TlsCertificateAlertDto,
  TlsInventoryFilter,
  BackupTargetsDto,
  BackupPolicyDto,
  SiteBackupPolicyDto,
  AdminSiteTemplatesListDto,
  AdminSiteTemplateDetailDto,
  AdminSiteTemplateVersionDto,
  CustomerSiteTypesDto,
  AdminAppTemplateSummaryDto,
  AdminAppTemplateDetailDto,
  AdminAppTemplateVersionDto,
  AdminAppTemplateUsageDto,
  AdminAppStacksDto,
  CustomerAppTemplatesDto,
  CustomerAppTemplateDto,
  AppStackSummaryDto,
  AppStackDetailDto,
  AppStackDeploymentDto,
  AppStackDomainDto,
  AppStackBackupsDto,
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

export type ServerResult<T> =
  | { ok: true; data: T; page?: { nextCursor: string | null; hasMore: boolean } }
  | { ok: false; outcome: "notFound" | "error"; status?: number; code?: string };

/**
 * GET for server components. A dead API session never renders misleading empty UI:
 * it goes through /api/session/expired, which clears the cookie and lands on /login.
 */
export async function serverGet<T>(
  path: string,
  opts?: { timeoutMs?: number },
): Promise<ServerResult<T>> {
  const session = await getServerSession();
  if (!session) redirect("/login");
  const upstreamOpts =
    opts?.timeoutMs !== undefined
      ? { accessToken: session.accessToken, timeoutMs: opts.timeoutMs }
      : { accessToken: session.accessToken };
  const res = await fetchUpstream<{ data: T; page?: { nextCursor: string | null; hasMore: boolean } }>(path, upstreamOpts);
  const outcome = classifyUpstream(res);
  if (outcome === "expired") redirect("/api/session/expired");
  if (outcome === "ok" && res.data?.data !== undefined)
    return { ok: true, data: res.data.data, ...(res.data.page ? { page: res.data.page } : {}) };
  const errObj = res.error as { error?: { code?: unknown } } | null | undefined;
  const code = typeof errObj?.error?.code === "string" ? errObj.error.code : undefined;
  // #8: the API refuses all but the password change until the temporary password is changed.
  if (res.status === 403 && code === "PASSWORD_CHANGE_REQUIRED") redirect("/account/change-password");
  return {
    ok: false,
    outcome: outcome === "notFound" ? "notFound" : "error",
    status: res.status,
    ...(code !== undefined ? { code } : {}),
  };
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

export type AuditQuery = { organizationId?: string; action?: string; from?: string; to?: string; cursor?: string };

/** One page of 50 audit events; the envelope's page carries the next cursor. */
export async function fetchServerAudit(query: AuditQuery = {}): Promise<ServerResult<AuditEventDto[]>> {
  const qs = new URLSearchParams({ limit: "50" });
  for (const [k, v] of Object.entries(query)) if (v) qs.set(k, v);
  return serverGet<AuditEventDto[]>(`v1/admin/audit?${qs}`);
}

/** null = the health snapshot could not be loaded. */
export async function fetchServerAdminHealth(): Promise<AdminHealthDto | null> {
  return orNull(await serverGet<AdminHealthDto>("v1/admin/health"));
}

/** null = the alerts could not be loaded (not "no alerts"). */
export async function fetchServerAdminAlerts(): Promise<AdminAlertDto[] | null> {
  return orNull(await serverGet<AdminAlertDto[]>("v1/admin/alerts"));
}

export async function fetchServerAdminFirewall(): Promise<FirewallDto | null> { return orNull(await serverGet<FirewallDto>("v1/admin/firewall", { timeoutMs: FIREWALL_BFF_TIMEOUT_MS })); }
export async function fetchServerAdminUpdates(): Promise<UpdatesDto | null> { return orNull(await serverGet<UpdatesDto>("v1/admin/updates")); }
export async function fetchServerAdminOsPackages(): Promise<OsPackagesDto | null> { return orNull(await serverGet<OsPackagesDto>("v1/admin/os-packages")); }

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

export async function fetchServerAdminSiteDomains(siteId: string): Promise<SiteDomainsDto | null> {
  return orNull(await serverGet<SiteDomainsDto>(`v1/admin/sites/${siteId}/domains`));
}

export async function fetchServerSiteDomains(orgId: string, siteId: string): Promise<SiteDomainsDto | null> {
  return orNull(await serverGet<SiteDomainsDto>(`v1/organizations/${orgId}/managed-sites/${siteId}/domains`));
}

export async function fetchServerAdminMailRelay(): Promise<MailRelaySettingsDto | null> {
  return orNull(await serverGet<MailRelaySettingsDto>("v1/admin/mail-relay"));
}

export async function fetchServerAdminNotifications(): Promise<NotificationSettingsDto | null> {
  return orNull(await serverGet<NotificationSettingsDto>("v1/admin/notifications"));
}

/** The whole result: a customer without the permission gets 403, and the page says so instead of an error. */
export async function fetchServerOrgNotifications(orgId: string): Promise<ServerResult<NotificationSettingsDto>> {
  if (!isValidPathSegment(orgId)) return { ok: false, outcome: "notFound" };
  return serverGet<NotificationSettingsDto>(`v1/organizations/${orgId}/notifications`);
}

export async function fetchServerAdminDnsProvider(): Promise<DnsProviderSettingsDto | null> {
  return orNull(await serverGet<DnsProviderSettingsDto>("v1/admin/dns-provider"));
}

/** Loads the administrator's backup destination and schedule settings, or null on request failure. */
export async function fetchServerAdminBackups(): Promise<BackupSettingsDto | null> {
  return orNull(await serverGet<BackupSettingsDto>("v1/admin/backups", { timeoutMs: 20_000 }));
}

/** Loads per-site backup status rows for the administrator table, or null on request failure. */
export async function fetchServerAdminBackupSites(): Promise<AdminSiteBackupStatusDto[] | null> {
  return orNull(await serverGet<AdminSiteBackupStatusDto[]>("v1/admin/backups/sites", { timeoutMs: 20_000 }));
}

/** The site's imported certificates (customer console); null = the list could not be loaded. */
export async function fetchServerSiteTlsCertificates(orgId: string, siteId: string): Promise<TlsCertificateDto[] | null> {
  return orNull(await serverGet<TlsCertificateDto[]>(`v1/organizations/${orgId}/managed-sites/${siteId}/tls-certificates`));
}

export async function fetchServerAdminSiteTlsCertificates(siteId: string): Promise<TlsCertificateDto[] | null> {
  return orNull(await serverGet<TlsCertificateDto[]>(`v1/admin/sites/${siteId}/tls-certificates`));
}

/** The administrator's inventory; only the whitelisted `filter` and a bounded `q` are sent upstream. */
export async function fetchServerAdminTlsCertificates(
  query: { filter: TlsInventoryFilter; q: string },
): Promise<AdminTlsInventoryItemDto[] | null> {
  const qs = new URLSearchParams();
  if (TLS_INVENTORY_FILTERS.includes(query.filter)) qs.set("filter", query.filter);
  const q = query.q.trim().slice(0, 253);
  if (q) qs.set("q", q);
  const suffix = qs.size > 0 ? `?${qs}` : "";
  return orNull(await serverGet<AdminTlsInventoryItemDto[]>(`v1/admin/tls-certificates${suffix}`));
}

export async function fetchServerAdminTlsAlerts(): Promise<TlsCertificateAlertDto[] | null> {
  return orNull(await serverGet<TlsCertificateAlertDto[]>("v1/admin/tls-certificates/alerts"));
}

/** The administrator's backup destinations; null = could not be loaded. */
export async function fetchServerAdminBackupTargets(): Promise<BackupTargetsDto | null> {
  return orNull(await serverGet<BackupTargetsDto>("v1/admin/backup-targets", { timeoutMs: 20_000 }));
}

export async function fetchServerAdminBackupPolicy(scope: "default" | "panel"): Promise<BackupPolicyDto | null> {
  return orNull(await serverGet<BackupPolicyDto>(`v1/admin/backup-policies/${scope}`));
}

/** The site's destination choice; 403/404 → null (the chooser stays hidden). */
export async function fetchServerSiteBackupPolicy(orgId: string, siteId: string): Promise<SiteBackupPolicyDto | null> {
  return orNull(await serverGet<SiteBackupPolicyDto>(`v1/organizations/${orgId}/managed-sites/${siteId}/backup-policy`));
}

/** The administrator's site templates (with the module facts); null = could not be loaded. */
export async function fetchServerAdminSiteTemplates(): Promise<AdminSiteTemplatesListDto | null> {
  return orNull(await serverGet<AdminSiteTemplatesListDto>("v1/admin/site-templates", { timeoutMs: 20_000 }));
}

/** notFound stays distinguishable: the page renders notFound(). */
export async function fetchServerAdminSiteTemplate(templateId: string): Promise<ServerResult<AdminSiteTemplateDetailDto>> {
  return serverGet<AdminSiteTemplateDetailDto>(`v1/admin/site-templates/${encodeURIComponent(templateId)}`);
}

export async function fetchServerAdminSiteTemplateVersion(
  templateId: string,
  versionId: string,
): Promise<AdminSiteTemplateVersionDto | null> {
  return orNull(
    await serverGet<AdminSiteTemplateVersionDto>(
      `v1/admin/site-templates/${encodeURIComponent(templateId)}/versions/${encodeURIComponent(versionId)}`,
    ),
  );
}

/** null = could not be loaded: the page behaves as today (no chooser, legacy body). */
export async function fetchServerCustomerSiteTypes(orgId: string): Promise<CustomerSiteTypesDto | null> {
  return orNull(await serverGet<CustomerSiteTypesDto>(`v1/organizations/${orgId}/site-types`));
}

// Application templates and stacks: results keep notFound and the flag-off code (NOT_SUPPORTED) apart.
const enc = encodeURIComponent;
/** An id that is not one path segment (`..`, `a/b`) is never put in a path: it reads as not found. */
const NOT_ONE_SEGMENT = { ok: false, outcome: "notFound" } as const;
const segments = (...ids: string[]) => ids.every(isValidPathSegment);

export async function fetchServerAdminAppTemplates(): Promise<ServerResult<AdminAppTemplateSummaryDto[]>> {
  return serverGet<AdminAppTemplateSummaryDto[]>("v1/admin/app-templates", { timeoutMs: 20_000 });
}

export async function fetchServerAdminAppTemplate(templateId: string): Promise<ServerResult<AdminAppTemplateDetailDto>> {
  if (!segments(templateId)) return NOT_ONE_SEGMENT;
  return serverGet<AdminAppTemplateDetailDto>(`v1/admin/app-templates/${enc(templateId)}`, { timeoutMs: 20_000 });
}

export async function fetchServerAdminAppTemplateVersion(
  templateId: string,
  versionId: string,
): Promise<ServerResult<AdminAppTemplateVersionDto>> {
  if (!segments(templateId, versionId)) return NOT_ONE_SEGMENT;
  return serverGet<AdminAppTemplateVersionDto>(
    `v1/admin/app-templates/${enc(templateId)}/versions/${enc(versionId)}`,
    { timeoutMs: 20_000 },
  );
}

export async function fetchServerAdminAppTemplateUsage(templateId: string): Promise<ServerResult<AdminAppTemplateUsageDto>> {
  if (!segments(templateId)) return NOT_ONE_SEGMENT;
  return serverGet<AdminAppTemplateUsageDto>(`v1/admin/app-templates/${enc(templateId)}/usage`);
}

export async function fetchServerAdminAppStacks(): Promise<ServerResult<AdminAppStacksDto>> {
  return serverGet<AdminAppStacksDto>("v1/admin/app-stacks");
}

export async function fetchServerOrgAppTemplates(orgId: string): Promise<ServerResult<CustomerAppTemplatesDto>> {
  return serverGet<CustomerAppTemplatesDto>(`v1/organizations/${enc(orgId)}/app-templates`);
}

export async function fetchServerOrgAppTemplate(orgId: string, templateId: string): Promise<ServerResult<CustomerAppTemplateDto>> {
  if (!segments(templateId)) return NOT_ONE_SEGMENT;
  return serverGet<CustomerAppTemplateDto>(`v1/organizations/${enc(orgId)}/app-templates/${enc(templateId)}`);
}

export async function fetchServerOrgAppStacks(orgId: string): Promise<ServerResult<AppStackSummaryDto[]>> {
  return serverGet<AppStackSummaryDto[]>(`v1/organizations/${enc(orgId)}/app-stacks`);
}

export async function fetchServerOrgAppStack(orgId: string, stackId: string): Promise<ServerResult<AppStackDetailDto>> {
  if (!segments(stackId)) return NOT_ONE_SEGMENT;
  return serverGet<AppStackDetailDto>(`v1/organizations/${enc(orgId)}/app-stacks/${enc(stackId)}`);
}

/** The newest 20 entries; null = could not be loaded. */
export async function fetchServerOrgAppStackDeployments(orgId: string, stackId: string): Promise<AppStackDeploymentDto[] | null> {
  if (!segments(stackId)) return null;
  return orNull(
    await serverGet<AppStackDeploymentDto[]>(`v1/organizations/${enc(orgId)}/app-stacks/${enc(stackId)}/deployments?limit=20`),
  );
}

export async function fetchServerOrgAppStackDomains(orgId: string, stackId: string): Promise<AppStackDomainDto[] | null> {
  if (!segments(stackId)) return null;
  return orNull(await serverGet<AppStackDomainDto[]>(`v1/organizations/${enc(orgId)}/app-stacks/${enc(stackId)}/domains`));
}

/** The backups and why a new one cannot be made; null = could not be loaded. */
export async function fetchServerOrgAppStackBackups(orgId: string, stackId: string): Promise<AppStackBackupsDto | null> {
  if (!segments(stackId)) return null;
  return orNull(await serverGet<AppStackBackupsDto>(`v1/organizations/${enc(orgId)}/app-stacks/${enc(stackId)}/backups`));
}
