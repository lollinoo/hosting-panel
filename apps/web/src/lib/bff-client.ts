import {
  AdminFleetItemDtoSchema,
  AdminProviderConnectionDtoSchema,
  ApiErrorEnvelopeSchema,
  ApplicationDetailDtoSchema,
  ApplicationSummaryDtoSchema,
  AsyncAcceptedEnvelopeSchema,
  AuditEventDtoSchema,
  createErrorEnvelope,
  createPaginatedListSchema,
  createSingleReadSchema,
  DatabaseDetailDtoSchema,
  DatabaseSummaryDtoSchema,
  DomainDtoSchema,
  MeDtoSchema,
  MemberDtoSchema,
  OperationDtoSchema,
  OrganizationCapabilitiesDtoSchema,
  OrganizationDetailDtoSchema,
  QuotaAllocationDtoSchema,
  ServerDtoSchema,
  ServerMetricsDtoSchema,
  type AdminFleetItemDto,
  type AdminProviderConnectionDto,
  type ApiErrorEnvelope,
  type ApplicationDetailDto,
  type ApplicationSummaryDto,
  type AsyncAcceptedEnvelope,
  type AuditEventDto,
  type DatabaseDetailDto,
  type DatabaseSummaryDto,
  type DomainDto,
  type MeDto,
  type MemberDto,
  type OperationDto,
  type OrganizationCapabilitiesDto,
  type OrganizationDetailDto,
  type PaginatedListEnvelope,
  type QuotaAllocationDto,
  type ServerDto,
  type ServerMetricsDto,
  type SingleReadEnvelope,
  type TriggerOperationInput,
} from "@hosting-panel/contracts";
import { z } from "zod";
import { resolveBffRequestId, type BffSessionUser } from "./session";

const DEFAULT_API_INTERNAL_URL = "http://127.0.0.1:4000";
const UPSTREAM_TIMEOUT_MS = 8_000;
const SAFE_SEGMENT_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

export function getApiInternalBaseUrl(): string {
  const raw = process.env["API_INTERNAL_URL"]?.trim();
  const base = raw && raw.length > 0 ? raw : DEFAULT_API_INTERNAL_URL;
  return base.replace(/\/+$/, "");
}

export function isValidPathSegment(segment: string): boolean {
  return SAFE_SEGMENT_PATTERN.test(segment);
}

function encodeSegment(segment: string, label: string): string {
  if (!isValidPathSegment(segment)) {
    throw new Error(`Invalid path identifier for ${label}.`);
  }
  return encodeURIComponent(segment);
}

export const DevPersonaSummarySchema = z.object({
  id: z.string().min(1),
  email: z.email(),
  displayName: z.string().min(1),
  isPlatformAdmin: z.boolean(),
  organizations: z.array(
    z.object({
      organizationId: z.string().min(1),
      organizationSlug: z.string().min(1),
      organizationName: z.string().min(1),
      organizationStatus: z.string().min(1),
      roles: z.array(z.string().min(1)),
    }),
  ),
});
export type DevPersonaSummary = z.infer<typeof DevPersonaSummarySchema>;

const DevPersonasEnvelopeSchema = z.object({
  data: z.array(DevPersonaSummarySchema),
});

const DevTokenIssuedEnvelopeSchema = z.object({
  data: z.object({
    accessToken: z.string().min(1),
    tokenType: z.literal("Bearer"),
    expiresIn: z.number().int().positive(),
    expiresAt: z.string().min(1),
    user: z.object({
      id: z.string().min(1),
      email: z.email(),
      displayName: z.string().min(1),
      isPlatformAdmin: z.boolean(),
    }),
  }),
});

export type UpstreamResult<TData> =
  | {
      readonly ok: true;
      readonly status: number;
      readonly requestId: string;
      readonly data: TData;
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly requestId: string;
      readonly error: ApiErrorEnvelope;
    };

interface UpstreamCallOptions {
  readonly method?: "GET" | "POST" | "DELETE";
  readonly accessToken?: string;
  readonly idempotencyKey?: string;
  readonly requestId?: string;
  readonly body?: unknown;
}

async function callUpstreamJson<TData>(
  pathnameWithQuery: string,
  schema: z.ZodType<TData>,
  options?: UpstreamCallOptions,
): Promise<UpstreamResult<TData>> {
  const requestId = options?.requestId ?? resolveBffRequestId();
  const baseUrl = getApiInternalBaseUrl();
  const targetUrl = `${baseUrl}${pathnameWithQuery}`;

  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Request-ID": requestId,
  };

  if (options?.accessToken) {
    headers["Authorization"] = `Bearer ${options.accessToken}`;
  }
  if (options?.idempotencyKey) {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }
  if (options?.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  let response: Response;
  try {
    response = await fetch(targetUrl, {
      method: options?.method ?? "GET",
      headers,
      body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return {
      ok: false,
      status: 503,
      requestId,
      error: createErrorEnvelope({
        code: "COOLIFY_UNAVAILABLE",
        message: "Il servizio API del Control Plane non è al momento raggiungibile.",
        requestId,
        retryable: true,
      }),
    };
  }

  const upstreamRequestId = response.headers.get("x-request-id")?.trim() || requestId;

  let rawJson: unknown;
  try {
    const text = await response.text();
    rawJson = text.trim().length > 0 ? (JSON.parse(text) as unknown) : null;
  } catch {
    return {
      ok: false,
      status: 502,
      requestId: upstreamRequestId,
      error: createErrorEnvelope({
        code: "INTERNAL_ERROR",
        message: "Risposta non valida ricevuta dal Control Plane API.",
        requestId: upstreamRequestId,
      }),
    };
  }

  if (!response.ok) {
    const parsedErr = ApiErrorEnvelopeSchema.safeParse(rawJson);
    if (parsedErr.success) {
      return {
        ok: false,
        status: response.status,
        requestId: parsedErr.data.error.requestId,
        error: parsedErr.data,
      };
    }

    return {
      ok: false,
      status: response.status,
      requestId: upstreamRequestId,
      error: createErrorEnvelope({
        code: response.status === 401 ? "UNAUTHENTICATED" : "INTERNAL_ERROR",
        message: "Si è verificato un errore durante la comunicazione con il backend.",
        requestId: upstreamRequestId,
      }),
    };
  }

  const parsedData = schema.safeParse(rawJson);
  if (!parsedData.success) {
    return {
      ok: false,
      status: 500,
      requestId: upstreamRequestId,
      error: createErrorEnvelope({
        code: "INTERNAL_ERROR",
        message: "Contratto dati backend non conforme allo schema previsto.",
        requestId: upstreamRequestId,
      }),
    };
  }

  return {
    ok: true,
    status: response.status,
    requestId: upstreamRequestId,
    data: parsedData.data,
  };
}

export async function fetchDevPersonas(): Promise<
  UpstreamResult<{ readonly data: readonly DevPersonaSummary[] }>
> {
  return callUpstreamJson("/v1/dev/auth/personas", DevPersonasEnvelopeSchema);
}

export async function issueDevAccessToken(input: {
  readonly userId?: string;
  readonly email?: string;
  readonly requestId?: string;
}): Promise<
  UpstreamResult<{
    readonly accessToken: string;
    readonly expiresIn: number;
    readonly user: BffSessionUser;
  }>
> {
  const res = await callUpstreamJson(
    "/v1/dev/auth/token",
    DevTokenIssuedEnvelopeSchema,
    {
      method: "POST",
      requestId: input.requestId,
      body: {
        ...(input.userId ? { userId: input.userId } : {}),
        ...(input.email ? { email: input.email } : {}),
      },
    },
  );

  if (!res.ok) {
    return res;
  }

  return {
    ok: true,
    status: res.status,
    requestId: res.requestId,
    data: {
      accessToken: res.data.data.accessToken,
      expiresIn: res.data.data.expiresIn,
      user: res.data.data.user,
    },
  };
}

export async function revokeUpstreamAccessToken(
  accessToken: string,
  requestId?: string,
): Promise<UpstreamResult<{ readonly data: { readonly revoked: boolean } }>> {
  return callUpstreamJson(
    "/v1/auth/revoke",
    z.object({
      data: z.object({
        revoked: z.boolean(),
        revokedAt: z.string().optional(),
      }),
    }),
    {
      method: "POST",
      accessToken,
      requestId,
      body: {},
    },
  );
}

const SingleMeSchema = createSingleReadSchema(MeDtoSchema);
const SingleOrgDetailSchema = createSingleReadSchema(OrganizationDetailDtoSchema);
const SingleOrgCapabilitiesSchema = createSingleReadSchema(
  OrganizationCapabilitiesDtoSchema,
);
const SingleQuotaSchema = createSingleReadSchema(QuotaAllocationDtoSchema);
const PaginatedMembersSchema = createPaginatedListSchema(MemberDtoSchema);
const PaginatedServersSchema = createPaginatedListSchema(ServerDtoSchema);
const SingleServerMetricsSchema = createSingleReadSchema(ServerMetricsDtoSchema);
const PaginatedAppsSchema = createPaginatedListSchema(ApplicationSummaryDtoSchema);
const SingleAppDetailSchema = createSingleReadSchema(ApplicationDetailDtoSchema);
const PaginatedDatabasesSchema = createPaginatedListSchema(DatabaseSummaryDtoSchema);
const SingleDatabaseDetailSchema = createSingleReadSchema(DatabaseDetailDtoSchema);
const PaginatedDomainsSchema = createPaginatedListSchema(DomainDtoSchema);
const PaginatedOperationsSchema = createPaginatedListSchema(OperationDtoSchema);
const SingleOperationSchema = createSingleReadSchema(OperationDtoSchema);
const PaginatedAdminProvidersSchema = createPaginatedListSchema(
  AdminProviderConnectionDtoSchema,
);
const SingleAdminProviderSchema = createSingleReadSchema(
  AdminProviderConnectionDtoSchema,
);
const PaginatedAdminFleetSchema = createPaginatedListSchema(AdminFleetItemDtoSchema);
const PaginatedAuditSchema = createPaginatedListSchema(AuditEventDtoSchema);

export async function fetchMe(
  accessToken: string,
  requestId?: string,
): Promise<UpstreamResult<SingleReadEnvelope<MeDto>>> {
  return callUpstreamJson("/v1/me", SingleMeSchema, { accessToken, requestId });
}

export async function fetchOrganizationDetail(
  accessToken: string,
  orgId: string,
): Promise<UpstreamResult<SingleReadEnvelope<OrganizationDetailDto>>> {
  const safeOrg = encodeSegment(orgId, "orgId");
  return callUpstreamJson(`/v1/organizations/${safeOrg}`, SingleOrgDetailSchema, {
    accessToken,
  });
}

export async function fetchOrganizationCapabilities(
  accessToken: string,
  orgId: string,
): Promise<UpstreamResult<SingleReadEnvelope<OrganizationCapabilitiesDto>>> {
  const safeOrg = encodeSegment(orgId, "orgId");
  return callUpstreamJson(
    `/v1/organizations/${safeOrg}/capabilities`,
    SingleOrgCapabilitiesSchema,
    { accessToken },
  );
}

export async function fetchOrganizationQuotas(
  accessToken: string,
  orgId: string,
): Promise<UpstreamResult<SingleReadEnvelope<QuotaAllocationDto>>> {
  const safeOrg = encodeSegment(orgId, "orgId");
  return callUpstreamJson(`/v1/organizations/${safeOrg}/quotas`, SingleQuotaSchema, {
    accessToken,
  });
}

export async function fetchOrganizationMembers(
  accessToken: string,
  orgId: string,
): Promise<UpstreamResult<PaginatedListEnvelope<MemberDto>>> {
  const safeOrg = encodeSegment(orgId, "orgId");
  return callUpstreamJson(
    `/v1/organizations/${safeOrg}/members?limit=100`,
    PaginatedMembersSchema,
    { accessToken },
  );
}

export async function fetchServers(
  accessToken: string,
  orgId: string,
): Promise<UpstreamResult<PaginatedListEnvelope<ServerDto>>> {
  const safeOrg = encodeSegment(orgId, "orgId");
  return callUpstreamJson(
    `/v1/organizations/${safeOrg}/servers?limit=100`,
    PaginatedServersSchema,
    { accessToken },
  );
}

export async function fetchServerMetrics(
  accessToken: string,
  orgId: string,
  serverId: string,
): Promise<UpstreamResult<SingleReadEnvelope<ServerMetricsDto>>> {
  const safeOrg = encodeSegment(orgId, "orgId");
  const safeSrv = encodeSegment(serverId, "serverId");
  return callUpstreamJson(
    `/v1/organizations/${safeOrg}/servers/${safeSrv}/metrics`,
    SingleServerMetricsSchema,
    { accessToken },
  );
}

export async function fetchApplications(
  accessToken: string,
  orgId: string,
): Promise<UpstreamResult<PaginatedListEnvelope<ApplicationSummaryDto>>> {
  const safeOrg = encodeSegment(orgId, "orgId");
  return callUpstreamJson(
    `/v1/organizations/${safeOrg}/applications?limit=100`,
    PaginatedAppsSchema,
    { accessToken },
  );
}

export async function fetchApplicationDetail(
  accessToken: string,
  orgId: string,
  appId: string,
): Promise<UpstreamResult<SingleReadEnvelope<ApplicationDetailDto>>> {
  const safeOrg = encodeSegment(orgId, "orgId");
  const safeApp = encodeSegment(appId, "appId");
  return callUpstreamJson(
    `/v1/organizations/${safeOrg}/applications/${safeApp}`,
    SingleAppDetailSchema,
    { accessToken },
  );
}

export async function fetchDatabases(
  accessToken: string,
  orgId: string,
): Promise<UpstreamResult<PaginatedListEnvelope<DatabaseSummaryDto>>> {
  const safeOrg = encodeSegment(orgId, "orgId");
  return callUpstreamJson(
    `/v1/organizations/${safeOrg}/databases?limit=100`,
    PaginatedDatabasesSchema,
    { accessToken },
  );
}

export async function fetchDatabaseDetail(
  accessToken: string,
  orgId: string,
  dbId: string,
): Promise<UpstreamResult<SingleReadEnvelope<DatabaseDetailDto>>> {
  const safeOrg = encodeSegment(orgId, "orgId");
  const safeDb = encodeSegment(dbId, "dbId");
  return callUpstreamJson(
    `/v1/organizations/${safeOrg}/databases/${safeDb}`,
    SingleDatabaseDetailSchema,
    { accessToken },
  );
}

export async function fetchDomains(
  accessToken: string,
  orgId: string,
): Promise<UpstreamResult<PaginatedListEnvelope<DomainDto>>> {
  const safeOrg = encodeSegment(orgId, "orgId");
  return callUpstreamJson(
    `/v1/organizations/${safeOrg}/domains?limit=100`,
    PaginatedDomainsSchema,
    { accessToken },
  );
}

export async function fetchOperations(
  accessToken: string,
  orgId: string,
): Promise<UpstreamResult<PaginatedListEnvelope<OperationDto>>> {
  const safeOrg = encodeSegment(orgId, "orgId");
  return callUpstreamJson(
    `/v1/organizations/${safeOrg}/operations?limit=50`,
    PaginatedOperationsSchema,
    { accessToken },
  );
}

export async function fetchOperationDetail(
  accessToken: string,
  orgId: string,
  opId: string,
  requestId?: string,
): Promise<UpstreamResult<SingleReadEnvelope<OperationDto>>> {
  const safeOrg = encodeSegment(orgId, "orgId");
  const safeOp = encodeSegment(opId, "opId");
  return callUpstreamJson(
    `/v1/organizations/${safeOrg}/operations/${safeOp}`,
    SingleOperationSchema,
    { accessToken, requestId },
  );
}

export async function triggerApplicationDeployUpstream(params: {
  readonly accessToken: string;
  readonly orgId: string;
  readonly appId: string;
  readonly idempotencyKey: string;
  readonly input: TriggerOperationInput;
  readonly requestId?: string;
}): Promise<UpstreamResult<AsyncAcceptedEnvelope>> {
  const safeOrg = encodeSegment(params.orgId, "orgId");
  const safeApp = encodeSegment(params.appId, "appId");
  const res = await callUpstreamJson(
    `/v1/organizations/${safeOrg}/applications/${safeApp}/deploy`,
    AsyncAcceptedEnvelopeSchema,
    {
      method: "POST",
      accessToken: params.accessToken,
      idempotencyKey: params.idempotencyKey,
      requestId: params.requestId,
      body: params.input,
    },
  );
  if (!res.ok) {
    return res;
  }
  return {
    ...res,
    data: {
      data: res.data.data,
      links: {
        self: `/api/bff/orgs/${safeOrg}/operations/${encodeURIComponent(res.data.data.operationId)}`,
      },
    },
  };
}

export async function triggerApplicationRestartUpstream(params: {
  readonly accessToken: string;
  readonly orgId: string;
  readonly appId: string;
  readonly idempotencyKey: string;
  readonly input: TriggerOperationInput;
  readonly requestId?: string;
}): Promise<UpstreamResult<AsyncAcceptedEnvelope>> {
  const safeOrg = encodeSegment(params.orgId, "orgId");
  const safeApp = encodeSegment(params.appId, "appId");
  const res = await callUpstreamJson(
    `/v1/organizations/${safeOrg}/applications/${safeApp}/restart`,
    AsyncAcceptedEnvelopeSchema,
    {
      method: "POST",
      accessToken: params.accessToken,
      idempotencyKey: params.idempotencyKey,
      requestId: params.requestId,
      body: params.input,
    },
  );
  if (!res.ok) {
    return res;
  }
  return {
    ...res,
    data: {
      data: res.data.data,
      links: {
        self: `/api/bff/orgs/${safeOrg}/operations/${encodeURIComponent(res.data.data.operationId)}`,
      },
    },
  };
}

export async function triggerDomainRecheckUpstream(params: {
  readonly accessToken: string;
  readonly orgId: string;
  readonly domainId: string;
  readonly idempotencyKey: string;
  readonly requestId?: string;
}): Promise<UpstreamResult<AsyncAcceptedEnvelope>> {
  const safeOrg = encodeSegment(params.orgId, "orgId");
  const safeDomain = encodeSegment(params.domainId, "domainId");
  const res = await callUpstreamJson(
    `/v1/organizations/${safeOrg}/domains/${safeDomain}/recheck`,
    AsyncAcceptedEnvelopeSchema,
    {
      method: "POST",
      accessToken: params.accessToken,
      idempotencyKey: params.idempotencyKey,
      requestId: params.requestId,
      body: {},
    },
  );
  if (!res.ok) {
    return res;
  }
  return {
    ...res,
    data: {
      data: res.data.data,
      links: {
        self: `/api/bff/orgs/${safeOrg}/operations/${encodeURIComponent(res.data.data.operationId)}`,
      },
    },
  };
}

export async function fetchAdminProviderConnections(
  accessToken: string,
): Promise<UpstreamResult<PaginatedListEnvelope<AdminProviderConnectionDto>>> {
  return callUpstreamJson(
    "/v1/admin/provider-connections?limit=50",
    PaginatedAdminProvidersSchema,
    { accessToken },
  );
}

export async function testAdminProviderConnectionUpstream(params: {
  readonly accessToken: string;
  readonly providerId: string;
  readonly requestId?: string;
}): Promise<UpstreamResult<SingleReadEnvelope<AdminProviderConnectionDto>>> {
  const safeId = encodeSegment(params.providerId, "providerId");
  return callUpstreamJson(
    `/v1/admin/provider-connections/${safeId}/test`,
    SingleAdminProviderSchema,
    {
      method: "POST",
      accessToken: params.accessToken,
      requestId: params.requestId,
      body: {},
    },
  );
}

export async function fetchAdminFleet(
  accessToken: string,
): Promise<UpstreamResult<PaginatedListEnvelope<AdminFleetItemDto>>> {
  return callUpstreamJson("/v1/admin/fleet?limit=100", PaginatedAdminFleetSchema, {
    accessToken,
  });
}

export async function fetchAdminAuditEvents(
  accessToken: string,
  filter?: {
    readonly organizationId?: string;
    readonly outcome?: string;
  },
): Promise<UpstreamResult<PaginatedListEnvelope<AuditEventDto>>> {
  const search = new URLSearchParams({ limit: "100" });
  if (filter?.organizationId && isValidPathSegment(filter.organizationId)) {
    search.set("organizationId", filter.organizationId);
  }
  if (
    filter?.outcome &&
    ["allowed", "denied", "succeeded", "failed"].includes(filter.outcome)
  ) {
    search.set("outcome", filter.outcome);
  }
  return callUpstreamJson(
    `/v1/admin/audit?${search.toString()}`,
    PaginatedAuditSchema,
    { accessToken },
  );
}
