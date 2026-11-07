import { z } from "zod";
import { OperationStatusSchema } from "./operations.js";
import { PermissionKeySchema, PresetRoleNameSchema } from "./permissions.js";

const IsoDateTimeSchema = z.iso.datetime({ offset: true });
const EntityIdSchema = z.string().min(1).max(128);

export const FORBIDDEN_PUBLIC_DTO_KEYS = [
  "providerId",
  "provider_id",
  "coolifyUuid",
  "coolify_uuid",
  "coolifyServerUuid",
  "coolifyProjectUuid",
  "coolifyApplicationUuid",
  "coolifyDatabaseUuid",
  "secretRef",
  "secret_ref",
  "token",
  "coolifyToken",
  "apiToken",
  "accessToken",
  "refreshToken",
  "providerBaseUrl",
  "coolifyBaseUrl",
  "internalBaseUrl",
] as const;

const FORBIDDEN_KEY_PATTERN =
  /^(provider_?id|coolify_?uuid|coolify.*uuid|secret_?ref|.*token|.*secret.*|.*password.*|authorization|cookie|provider_?base_?url|coolify_?base_?url|internal_?base_?url)$/i;

export function findForbiddenPublicDtoKeys(value: unknown): string[] {
  const found: string[] = [];

  function walk(current: unknown, pathPrefix: string): void {
    if (current === null || typeof current !== "object") {
      return;
    }

    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        walk(current[index], `${pathPrefix}[${String(index)}]`);
      }
      return;
    }

    for (const [key, nested] of Object.entries(current as Record<string, unknown>)) {
      const fullPath = pathPrefix ? `${pathPrefix}.${key}` : key;
      if (FORBIDDEN_KEY_PATTERN.test(key)) {
        found.push(fullPath);
      }
      walk(nested, fullPath);
    }
  }

  walk(value, "");
  return found;
}

export const OBSERVED_RESOURCE_STATUSES = [
  "running",
  "stopped",
  "deploying",
  "degraded",
  "failed",
  "unknown",
] as const;
export const ObservedResourceStatusSchema = z.enum(OBSERVED_RESOURCE_STATUSES);
export type ObservedResourceStatus = z.infer<typeof ObservedResourceStatusSchema>;

export const RESOURCE_HEALTH_STATUSES = ["healthy", "unhealthy", "unknown"] as const;
export const ResourceHealthStatusSchema = z.enum(RESOURCE_HEALTH_STATUSES);
export type ResourceHealthStatus = z.infer<typeof ResourceHealthStatusSchema>;

export const OBSERVATION_SOURCES = ["coolify", "monitoring", "external_probe"] as const;
export const ObservationSourceSchema = z.enum(OBSERVATION_SOURCES);
export type ObservationSource = z.infer<typeof ObservationSourceSchema>;

export const RESOURCE_TYPES = ["application", "database"] as const;
export const ResourceTypeSchema = z.enum(RESOURCE_TYPES);
export type ResourceType = z.infer<typeof ResourceTypeSchema>;

export const CERTIFICATE_STATUSES = [
  "valid",
  "expiring_soon",
  "expired",
  "mismatch",
  "missing",
  "unknown",
] as const;
export const CertificateStatusSchema = z.enum(CERTIFICATE_STATUSES);
export type CertificateStatus = z.infer<typeof CertificateStatusSchema>;

export const DOMAIN_VERIFICATION_STATUSES = [
  "pending",
  "verified",
  "conflict",
  "failed",
] as const;
export const DomainVerificationStatusSchema = z.enum(DOMAIN_VERIFICATION_STATUSES);
export type DomainVerificationStatus = z.infer<typeof DomainVerificationStatusSchema>;

export const DATABASE_ENGINES = [
  "postgresql",
  "mysql",
  "mariadb",
  "mongodb",
  "redis",
] as const;
export const DatabaseEngineSchema = z.enum(DATABASE_ENGINES);
export type DatabaseEngine = z.infer<typeof DatabaseEngineSchema>;

export const ORGANIZATION_TYPES = ["customer", "reseller", "platform"] as const;
export const OrganizationTypeSchema = z.enum(ORGANIZATION_TYPES);
export type OrganizationType = z.infer<typeof OrganizationTypeSchema>;

export const ORGANIZATION_STATUSES = [
  "active",
  "past_due",
  "suspended",
  "cancelled",
] as const;
export const OrganizationStatusSchema = z.enum(ORGANIZATION_STATUSES);
export type OrganizationStatus = z.infer<typeof OrganizationStatusSchema>;

export const PROVIDER_CONNECTION_STATUSES = [
  "connected",
  "degraded",
  "unreachable",
  "misconfigured",
  "unknown",
] as const;
export const ProviderConnectionStatusSchema = z.enum(PROVIDER_CONNECTION_STATUSES);
export type ProviderConnectionStatus = z.infer<typeof ProviderConnectionStatusSchema>;

export const ProviderCapabilityEntrySchema = z.object({
  supported: z.boolean(),
  reason: z.string().nullable().optional(),
});
export type ProviderCapabilityEntry = z.infer<typeof ProviderCapabilityEntrySchema>;

export const ProviderCapabilitiesSchema = z.object({
  applicationDeploy: ProviderCapabilityEntrySchema,
  applicationRestart: ProviderCapabilityEntrySchema,
  applicationStop: ProviderCapabilityEntrySchema,
  applicationLogs: ProviderCapabilityEntrySchema,
  domainManage: ProviderCapabilityEntrySchema,
  certificateRecheck: ProviderCapabilityEntrySchema,
  serverMetrics: ProviderCapabilityEntrySchema,
  databaseBackupByEngine: z.object({
    postgresql: ProviderCapabilityEntrySchema,
    mysql: ProviderCapabilityEntrySchema,
    mariadb: ProviderCapabilityEntrySchema,
    mongodb: ProviderCapabilityEntrySchema,
    redis: ProviderCapabilityEntrySchema,
  }),
});
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

export const DEFAULT_COOLIFY_V4_CAPABILITIES: ProviderCapabilities = Object.freeze({
  applicationDeploy: Object.freeze({ supported: true, reason: null }),
  applicationRestart: Object.freeze({ supported: true, reason: null }),
  applicationStop: Object.freeze({ supported: true, reason: null }),
  applicationLogs: Object.freeze({ supported: true, reason: null }),
  domainManage: Object.freeze({ supported: true, reason: null }),
  certificateRecheck: Object.freeze({ supported: true, reason: null }),
  serverMetrics: Object.freeze({ supported: true, reason: null }),
  databaseBackupByEngine: Object.freeze({
    postgresql: Object.freeze({ supported: true, reason: null }),
    mysql: Object.freeze({ supported: true, reason: null }),
    mariadb: Object.freeze({ supported: true, reason: null }),
    mongodb: Object.freeze({ supported: true, reason: null }),
    redis: Object.freeze({
      supported: false,
      reason: "Automated backups and restores are not supported for Redis instances.",
    }),
  }),
});

export interface DatabaseBackupCapabilitySummary {
  readonly backupSupported: boolean;
  readonly restoreSupported: boolean;
  readonly backupUnsupportedReason: string | null;
}

export function getDatabaseBackupCapabilities(
  engine: DatabaseEngine,
): DatabaseBackupCapabilitySummary {
  if (engine === "redis") {
    return {
      backupSupported: false,
      restoreSupported: false,
      backupUnsupportedReason:
        "Automated backups and restores are not supported for Redis instances.",
    };
  }

  return {
    backupSupported: true,
    restoreSupported: true,
    backupUnsupportedReason: null,
  };
}

export const ReadMetaSchema = z.object({
  observedAt: IsoDateTimeSchema.nullable(),
  source: ObservationSourceSchema,
  stale: z.boolean(),
});
export type ReadMeta = z.infer<typeof ReadMetaSchema>;

export const CursorPageSchema = z.object({
  nextCursor: z.string().min(1).nullable(),
  hasMore: z.boolean(),
});
export type CursorPage = z.infer<typeof CursorPageSchema>;

export interface SingleReadEnvelope<TData> {
  data: TData;
  meta?: ReadMeta | undefined;
}

export interface PaginatedListEnvelope<TItem> {
  data: TItem[];
  page: CursorPage;
  meta?: ReadMeta | undefined;
}

export function createSingleReadSchema<TSchema extends z.ZodType>(dataSchema: TSchema) {
  return z.object({
    data: dataSchema,
    meta: ReadMetaSchema.optional(),
  });
}

export function createPaginatedListSchema<TSchema extends z.ZodType>(itemSchema: TSchema) {
  return z.object({
    data: z.array(itemSchema),
    page: CursorPageSchema,
    meta: ReadMetaSchema.optional(),
  });
}

export const MeMembershipDtoSchema = z.object({
  organizationId: EntityIdSchema,
  organizationSlug: z.string().min(1),
  organizationName: z.string().min(1),
  organizationType: OrganizationTypeSchema,
  organizationStatus: OrganizationStatusSchema,
  roles: z.array(z.string().min(1)),
  permissions: z.array(PermissionKeySchema),
});
export type MeMembershipDto = z.infer<typeof MeMembershipDtoSchema>;

export const MeImpersonationContextSchema = z.object({
  active: z.boolean(),
  sessionId: EntityIdSchema.nullable(),
  targetOrganizationId: EntityIdSchema.nullable(),
  expiresAt: IsoDateTimeSchema.nullable(),
});
export type MeImpersonationContext = z.infer<typeof MeImpersonationContextSchema>;

export const MeDtoSchema = z.object({
  user: z.object({
    id: EntityIdSchema,
    email: z.email(),
    displayName: z.string().min(1),
    isPlatformAdmin: z.boolean(),
  }),
  memberships: z.array(MeMembershipDtoSchema),
  impersonation: MeImpersonationContextSchema.optional(),
});
export type MeDto = z.infer<typeof MeDtoSchema>;

export const OrganizationSummaryDtoSchema = z.object({
  id: EntityIdSchema,
  slug: z.string().min(1),
  name: z.string().min(1),
  type: OrganizationTypeSchema,
  status: OrganizationStatusSchema,
  createdAt: IsoDateTimeSchema,
});
export type OrganizationSummaryDto = z.infer<typeof OrganizationSummaryDtoSchema>;

export const OrganizationDetailDtoSchema = OrganizationSummaryDtoSchema.extend({
  primaryLocale: z.string().min(2),
  memberCount: z.number().int().nonnegative(),
  serverCount: z.number().int().nonnegative(),
  applicationCount: z.number().int().nonnegative(),
  databaseCount: z.number().int().nonnegative(),
  updatedAt: IsoDateTimeSchema,
});
export type OrganizationDetailDto = z.infer<typeof OrganizationDetailDtoSchema>;

export const OrganizationCapabilitiesDtoSchema = z.object({
  organizationId: EntityIdSchema,
  permissions: z.array(PermissionKeySchema),
  features: ProviderCapabilitiesSchema,
  evaluatedAt: IsoDateTimeSchema,
});
export type OrganizationCapabilitiesDto = z.infer<typeof OrganizationCapabilitiesDtoSchema>;

export const MemberDtoSchema = z.object({
  membershipId: EntityIdSchema,
  organizationId: EntityIdSchema,
  userId: EntityIdSchema,
  email: z.email(),
  displayName: z.string().min(1),
  roles: z.array(z.string().min(1)),
  joinedAt: IsoDateTimeSchema,
});
export type MemberDto = z.infer<typeof MemberDtoSchema>;

export const CreateInvitationInputSchema = z.strictObject({
  email: z.email(),
  roles: z.array(PresetRoleNameSchema).min(1),
});
export type CreateInvitationInput = z.infer<typeof CreateInvitationInputSchema>;

export const ServerDtoSchema = z.object({
  id: EntityIdSchema,
  organizationId: EntityIdSchema,
  name: z.string().min(1),
  region: z.string().min(1),
  publicIpv4: z.string().min(1).nullable(),
  status: ObservedResourceStatusSchema,
  health: ResourceHealthStatusSchema,
  vcpuCount: z.number().int().positive(),
  memoryMb: z.number().int().positive(),
  diskGb: z.number().int().positive(),
  lastObservedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type ServerDto = z.infer<typeof ServerDtoSchema>;

export const ServerMetricsDtoSchema = z.object({
  serverId: EntityIdSchema,
  cpuUsagePercent: z.number().min(0).max(100).nullable(),
  memoryUsedMb: z.number().nonnegative().nullable(),
  memoryTotalMb: z.number().positive().nullable(),
  diskUsedGb: z.number().nonnegative().nullable(),
  diskTotalGb: z.number().positive().nullable(),
  uptimeSeconds: z.number().int().nonnegative().nullable(),
  observedAt: IsoDateTimeSchema.nullable(),
});
export type ServerMetricsDto = z.infer<typeof ServerMetricsDtoSchema>;

export const ApplicationSummaryDtoSchema = z.object({
  id: EntityIdSchema,
  organizationId: EntityIdSchema,
  serverId: EntityIdSchema,
  name: z.string().min(1),
  slug: z.string().min(1),
  environment: z.string().min(1),
  status: ObservedResourceStatusSchema,
  health: ResourceHealthStatusSchema,
  primaryDomain: z.string().min(1).nullable(),
  lastDeployedAt: IsoDateTimeSchema.nullable(),
  lastObservedAt: IsoDateTimeSchema.nullable(),
  lockedByOperationId: EntityIdSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type ApplicationSummaryDto = z.infer<typeof ApplicationSummaryDtoSchema>;

export const DeploymentRecordDtoSchema = z.object({
  id: EntityIdSchema,
  applicationId: EntityIdSchema,
  operationId: EntityIdSchema.nullable(),
  commitSha: z.string().min(1).nullable(),
  imageTag: z.string().min(1).nullable(),
  status: OperationStatusSchema,
  triggeredByUserId: EntityIdSchema.nullable(),
  startedAt: IsoDateTimeSchema.nullable(),
  finishedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type DeploymentRecordDto = z.infer<typeof DeploymentRecordDtoSchema>;

export const ApplicationAllowedActionsSchema = z.object({
  canDeploy: z.boolean(),
  canRestart: z.boolean(),
  canStop: z.boolean(),
  canReadLogs: z.boolean(),
});
export type ApplicationAllowedActions = z.infer<typeof ApplicationAllowedActionsSchema>;

export const ApplicationDetailDtoSchema = ApplicationSummaryDtoSchema.extend({
  repositoryUrl: z.string().min(1).nullable(),
  branch: z.string().min(1).nullable(),
  buildPack: z.string().min(1),
  domains: z.array(z.string().min(1)),
  allowedActions: ApplicationAllowedActionsSchema,
  recentDeployments: z.array(DeploymentRecordDtoSchema),
  updatedAt: IsoDateTimeSchema,
});
export type ApplicationDetailDto = z.infer<typeof ApplicationDetailDtoSchema>;

export const TriggerOperationInputSchema = z.strictObject({
  reason: z.string().trim().min(1).max(500).optional(),
  forceRebuild: z.boolean().optional(),
});
export type TriggerOperationInput = z.infer<typeof TriggerOperationInputSchema>;

export const DatabaseSummaryDtoSchema = z.object({
  id: EntityIdSchema,
  organizationId: EntityIdSchema,
  serverId: EntityIdSchema,
  name: z.string().min(1),
  engine: DatabaseEngineSchema,
  engineVersion: z.string().min(1),
  status: ObservedResourceStatusSchema,
  health: ResourceHealthStatusSchema,
  backupSupported: z.boolean(),
  restoreSupported: z.boolean(),
  lastBackupAt: IsoDateTimeSchema.nullable(),
  lastObservedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type DatabaseSummaryDto = z.infer<typeof DatabaseSummaryDtoSchema>;

export const DatabaseDetailDtoSchema = DatabaseSummaryDtoSchema.extend({
  storageAllocatedGb: z.number().positive(),
  internalHostname: z.string().min(1).nullable(),
  port: z.number().int().min(1).max(65535).nullable(),
  backupUnsupportedReason: z.string().nullable(),
  updatedAt: IsoDateTimeSchema,
});
export type DatabaseDetailDto = z.infer<typeof DatabaseDetailDtoSchema>;

export const CertificateObservationDtoSchema = z.object({
  id: EntityIdSchema,
  domainId: EntityIdSchema,
  organizationId: EntityIdSchema,
  hostname: z.string().min(1),
  status: CertificateStatusSchema,
  issuer: z.string().min(1).nullable(),
  validFrom: IsoDateTimeSchema.nullable(),
  expiresAt: IsoDateTimeSchema.nullable(),
  observedAt: IsoDateTimeSchema.nullable(),
  source: ObservationSourceSchema,
});
export type CertificateObservationDto = z.infer<typeof CertificateObservationDtoSchema>;

export const DomainDtoSchema = z.object({
  id: EntityIdSchema,
  organizationId: EntityIdSchema,
  applicationId: EntityIdSchema,
  hostname: z.string().min(1),
  isPrimary: z.boolean(),
  verificationStatus: DomainVerificationStatusSchema,
  httpsEnabled: z.boolean(),
  certificate: CertificateObservationDtoSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type DomainDto = z.infer<typeof DomainDtoSchema>;

export const QuotaAllocationDtoSchema = z.object({
  organizationId: EntityIdSchema,
  planCode: z.string().min(1),
  serversUsed: z.number().int().nonnegative(),
  serversLimit: z.number().int().nonnegative(),
  applicationsUsed: z.number().int().nonnegative(),
  applicationsLimit: z.number().int().nonnegative(),
  databasesUsed: z.number().int().nonnegative(),
  databasesLimit: z.number().int().nonnegative(),
  domainsUsed: z.number().int().nonnegative(),
  domainsLimit: z.number().int().nonnegative(),
  updatedAt: IsoDateTimeSchema,
});
export type QuotaAllocationDto = z.infer<typeof QuotaAllocationDtoSchema>;

export const AUDIT_EVENT_OUTCOMES = ["allowed", "denied", "succeeded", "failed"] as const;
export const AuditEventOutcomeSchema = z.enum(AUDIT_EVENT_OUTCOMES);
export type AuditEventOutcome = z.infer<typeof AuditEventOutcomeSchema>;

const AuditMetadataValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const AuditMetadataSchema = z
  .record(z.string(), AuditMetadataValueSchema)
  .superRefine((metadata, ctx) => {
    for (const key of Object.keys(metadata)) {
      if (FORBIDDEN_KEY_PATTERN.test(key)) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `Forbidden secret or provider selector key '${key}' is not permitted in public audit metadata.`,
        });
      }
    }
  });
export type AuditMetadata = z.infer<typeof AuditMetadataSchema>;

export const AuditEventDtoSchema = z.object({
  id: EntityIdSchema,
  organizationId: EntityIdSchema.nullable(),
  actorUserId: EntityIdSchema.nullable(),
  actorEmail: z.email().nullable(),
  impersonatedByUserId: EntityIdSchema.nullable(),
  action: z.string().min(1),
  targetType: z.string().min(1),
  targetId: z.string().min(1).nullable(),
  outcome: AuditEventOutcomeSchema,
  requestId: z.string().min(1),
  ipAddress: z.string().min(1).nullable(),
  metadata: AuditMetadataSchema,
  occurredAt: IsoDateTimeSchema,
});
export type AuditEventDto = z.infer<typeof AuditEventDtoSchema>;

export const AdminProviderConnectionDtoSchema = z.object({
  id: EntityIdSchema,
  displayName: z.string().min(1),
  driver: z.literal("coolify-v4"),
  status: ProviderConnectionStatusSchema,
  version: z.string().min(1).nullable(),
  capabilities: ProviderCapabilitiesSchema,
  boundOrganizationCount: z.number().int().nonnegative(),
  lastCheckedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type AdminProviderConnectionDto = z.infer<typeof AdminProviderConnectionDtoSchema>;

export const AdminFleetItemDtoSchema = z.object({
  resourceId: EntityIdSchema,
  resourceType: ResourceTypeSchema,
  resourceName: z.string().min(1),
  organizationId: EntityIdSchema,
  organizationName: z.string().min(1),
  serverId: EntityIdSchema,
  serverName: z.string().min(1),
  status: ObservedResourceStatusSchema,
  health: ResourceHealthStatusSchema,
  stale: z.boolean(),
  lastObservedAt: IsoDateTimeSchema.nullable(),
});
export type AdminFleetItemDto = z.infer<typeof AdminFleetItemDtoSchema>;
