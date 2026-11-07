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
  DevPersonaDto,
} from "@hosting-panel/contracts";

export async function fetchServerPersonas(): Promise<DevPersonaDto[]> {
  const res = await fetchUpstream<{ data: DevPersonaDto[] }>("v1/dev/auth/personas");
  if (res.ok && res.data?.data) {
    return res.data.data;
  }
  // Fallback dev personas if upstream is offline/mocking
  return [
    {
      id: "persona-infra-admin",
      email: "admin@platform.local",
      name: "Alice Fontana (Infrastructure Admin)",
      description: "Amministratore infrastruttura Linux/Docker Engine con permessi host",
      role: "infrastructure_admin",
      globalRoles: ["infrastructure_admin"],
      organizationId: null,
    },
    {
      id: "persona-hosting-admin",
      email: "hosting@platform.local",
      name: "Marco Riva (Hosting Admin)",
      description: "Gestione allocazioni e catalogo template (segregato da daemon host)",
      role: "hosting_admin",
      globalRoles: ["hosting_admin"],
      organizationId: null,
    },
    {
      id: "persona-customer-owner",
      email: "owner@acme.it",
      name: "Giulia Rossi (Customer Owner)",
      description: "Proprietario organizzazione Acme Corp con gestione siti e stack",
      role: "customer_owner",
      globalRoles: [],
      organizationId: "org-acme",
    },
    {
      id: "persona-customer-collab",
      email: "dev@acme.it",
      name: "Luca Bianchi (Customer Collaborator)",
      description: "Collaboratore con permessi di sola lettura e deployment limitati",
      role: "customer_collaborator",
      globalRoles: [],
      organizationId: "org-acme",
    },
    {
      id: "persona-suspended-owner",
      email: "suspended@demo.it",
      name: "Paolo Neri (Organizzazione Sospesa)",
      description: "Organizzazione sospesa per verifica policy o mancato pagamento",
      role: "customer_owner",
      globalRoles: [],
      organizationId: "org-suspended",
    },
  ];
}

export async function fetchServerMe(): Promise<MeDto | null> {
  const session = await getServerSession();
  if (!session) return null;
  const res = await fetchUpstream<{ data: MeDto }>("v1/me", {
    accessToken: session.accessToken,
  });
  return res.ok && res.data?.data ? res.data.data : null;
}

export async function fetchServerHosts(): Promise<HostDto[]> {
  const session = await getServerSession();
  if (!session) return [];
  const res = await fetchUpstream<{ data: HostDto[] }>("v1/hosts", {
    accessToken: session.accessToken,
  });
  return res.ok && res.data?.data ? res.data.data : [];
}

export async function fetchServerHost(hostId: string): Promise<HostDto | null> {
  const session = await getServerSession();
  if (!session) return null;
  const res = await fetchUpstream<{ data: HostDto }>(`v1/hosts/${hostId}`, {
    accessToken: session.accessToken,
  });
  return res.ok && res.data?.data ? res.data.data : null;
}

export async function fetchServerHostAllocations(hostId: string): Promise<HostAllocationDto[]> {
  const session = await getServerSession();
  if (!session) return [];
  const res = await fetchUpstream<{ data: HostAllocationDto[] }>(`v1/hosts/${hostId}/allocations`, {
    accessToken: session.accessToken,
  });
  return res.ok && res.data?.data ? res.data.data : [];
}

export async function fetchServerAllocations(): Promise<HostAllocationDto[]> {
  const session = await getServerSession();
  if (!session) return [];
  const res = await fetchUpstream<{ data: HostAllocationDto[] }>("v1/allocations", {
    accessToken: session.accessToken,
  });
  return res.ok && res.data?.data ? res.data.data : [];
}

export async function fetchServerTemplates(): Promise<ServiceTemplateDto[]> {
  const session = await getServerSession();
  if (!session) return [];
  const res = await fetchUpstream<{ data: ServiceTemplateDto[] }>("v1/service-templates", {
    accessToken: session.accessToken,
  });
  return res.ok && res.data?.data ? res.data.data : [];
}

export async function fetchServerAudit(): Promise<AuditEventDto[]> {
  const session = await getServerSession();
  if (!session) return [];
  const res = await fetchUpstream<{ data: AuditEventDto[] }>("v1/admin/audit", {
    accessToken: session.accessToken,
  });
  return res.ok && res.data?.data ? res.data.data : [];
}

export async function fetchServerOrg(orgId: string): Promise<OrganizationDetailDto | null> {
  const session = await getServerSession();
  if (!session) return null;
  const res = await fetchUpstream<{ data: OrganizationDetailDto }>(`v1/organizations/${orgId}`, {
    accessToken: session.accessToken,
  });
  return res.ok && res.data?.data ? res.data.data : null;
}

export async function fetchServerOrgSites(orgId: string): Promise<SiteSummaryDto[]> {
  const session = await getServerSession();
  if (!session) return [];
  const res = await fetchUpstream<{ data: SiteSummaryDto[] }>(`v1/organizations/${orgId}/sites`, {
    accessToken: session.accessToken,
  });
  return res.ok && res.data?.data ? res.data.data : [];
}

export async function fetchServerOrgSite(orgId: string, siteId: string): Promise<SiteDetailDto | null> {
  const session = await getServerSession();
  if (!session) return null;
  const res = await fetchUpstream<{ data: SiteDetailDto }>(
    `v1/organizations/${orgId}/sites/${siteId}`,
    { accessToken: session.accessToken }
  );
  return res.ok && res.data?.data ? res.data.data : null;
}

export async function fetchServerOrgQuotas(orgId: string): Promise<ResourceQuotaDto | null> {
  const session = await getServerSession();
  if (!session) return null;
  const res = await fetchUpstream<{ data: ResourceQuotaDto }>(
    `v1/organizations/${orgId}/quotas`,
    { accessToken: session.accessToken }
  );
  return res.ok && res.data?.data ? res.data.data : null;
}

export async function fetchServerOrgMembers(orgId: string): Promise<MemberDto[]> {
  const session = await getServerSession();
  if (!session) return [];
  const res = await fetchUpstream<{ data: MemberDto[] }>(
    `v1/organizations/${orgId}/members`,
    { accessToken: session.accessToken }
  );
  return res.ok && res.data?.data ? res.data.data : [];
}

export async function fetchServerOrgOperations(orgId: string): Promise<OperationDto[]> {
  const session = await getServerSession();
  if (!session) return [];
  const res = await fetchUpstream<{ data: OperationDto[] }>(
    `v1/organizations/${orgId}/operations`,
    { accessToken: session.accessToken }
  );
  return res.ok && res.data?.data ? res.data.data : [];
}
