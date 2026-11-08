import { z } from "zod";
import { PresetRoleNameSchema } from "./permissions.js";

const IsoDateTimeSchema = z.string().datetime({ offset: true });
const EntityIdSchema = z.string().min(1).max(128);

export const FORBIDDEN_PUBLIC_DTO_KEYS = [
  "dockerContainerId",
  "dockerNetworkId",
  "dockerVolumeName",
  "internalDockerRef",
  "socketPath",
  "dockerSocket",
  "hostPath",
  "bindMount",
  "secretRef",
  "password",
  "passwordHash",
  "accessToken",
  "refreshToken",
  "privateKey",
  "apiKey",
  "ciphertext",
  "ciphertextBase64",
  "ivBase64",
  "authTagBase64",
  "secretValue",
  "resolvedSecrets",
] as const;

const FORBIDDEN_KEY_PATTERN =
  /^(dockerContainerId|dockerNetworkId|dockerVolumeName|internalDockerRef|socketPath|dockerSocket|hostPath|bindMount|secretRef|password|passwordHash|accessToken|refreshToken|privateKey|apiKey|ciphertext|ciphertextBase64|ivBase64|authTagBase64|secretValue|resolvedSecrets|docker_container_id|docker_network_id|docker_volume_name|internal_docker_ref|socket_path|docker_socket|host_path|bind_mount|secret_ref|password_hash|access_token|refresh_token|private_key|api_key|ciphertext_base64|iv_base64|auth_tag_base64|secret_value|resolved_secrets)$/i;

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

export const UNSAFE_DOCKER_KEYS = new Set([
  "privileged",
  "hostPath",
  "binds",
  "dockerSocket",
  "capAdd",
  "devices",
  "dockerEndpoint",
  "dockerFlags",
  "networkMode",
  "pidMode",
  "ipcMode",
]);

export function findUnsafeDockerInputFields(value: unknown): string[] {
  const violations: string[] = [];

  function walk(current: unknown, pathPrefix: string): void {
    if (current === null || typeof current !== "object") {
      if (typeof current === "string" && current.includes("/var/run/docker.sock")) {
        violations.push(pathPrefix);
      }
      return;
    }

    if (Array.isArray(current)) {
      for (let i = 0; i < current.length; i++) {
        walk(current[i], `${pathPrefix}[${i}]`);
      }
      return;
    }

    for (const [k, v] of Object.entries(current as Record<string, unknown>)) {
      const fullPath = pathPrefix ? `${pathPrefix}.${k}` : k;

      if (
        k === "privileged" &&
        (v === true || v === "true" || v === 1)
      ) {
        violations.push(fullPath);
      } else if (
        k === "hostPath" ||
        k === "binds" ||
        k === "dockerSocket" ||
        k === "capAdd" ||
        k === "devices" ||
        k === "dockerEndpoint" ||
        k === "dockerFlags"
      ) {
        violations.push(fullPath);
      } else if (
        (k === "networkMode" || k === "pidMode" || k === "ipcMode") &&
        v === "host"
      ) {
        violations.push(fullPath);
      } else if (typeof v === "string" && v.includes("/var/run/docker.sock")) {
        violations.push(fullPath);
      }

      walk(v, fullPath);
    }
  }

  walk(value, "");
  return violations;
}

const PLAINTEXT_SECRET_KEY_PATTERN =
  /^(password|secret|apiKey|privateKey|token|connectionString|secretValue|resolvedSecrets|api_key|private_key|connection_string|client_secret|auth_token|secret_value|resolved_secrets)$/i;

export function findPlaintextSecretKeys(value: unknown): string[] {
  const violations: string[] = [];

  function walk(current: unknown, pathPrefix: string): void {
    if (current === null || typeof current !== "object") {
      return;
    }

    if (Array.isArray(current)) {
      for (let i = 0; i < current.length; i++) {
        walk(current[i], `${pathPrefix}[${i}]`);
      }
      return;
    }

    for (const [k, v] of Object.entries(current as Record<string, unknown>)) {
      const fullPath = pathPrefix ? `${pathPrefix}.${k}` : k;
      if (PLAINTEXT_SECRET_KEY_PATTERN.test(k) && v !== null && v !== undefined && v !== "") {
        violations.push(fullPath);
      }
      walk(v, fullPath);
    }
  }

  walk(value, "");
  return violations;
}

export function redactSensitiveString(str: string): string {
  return str.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]");
}

export function redactSensitiveValue<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") {
      return redactSensitiveString(value) as unknown as T;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveValue(item)) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEY_PATTERN.test(k) || PLAINTEXT_SECRET_KEY_PATTERN.test(k)) {
      result[k] = "[REDACTED]";
    } else {
      result[k] = redactSensitiveValue(v);
    }
  }
  return result as unknown as T;
}

// Envelopes
export const ReadMetaSchema = z.object({
  total: z.number().int().nonnegative().optional(),
  cursor: z.string().nullable().optional(),
  requestId: z.string().min(1),
  timestamp: IsoDateTimeSchema,
});
export type ReadMeta = z.infer<typeof ReadMetaSchema>;

export const CursorPageSchema = z.object({
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});
export type CursorPage = z.infer<typeof CursorPageSchema>;

export function createSingleReadSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({
    data: itemSchema,
  });
}

export function createPaginatedListSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({
    data: z.array(itemSchema),
    meta: ReadMetaSchema,
    page: CursorPageSchema,
  });
}

// Capabilities
export const RUNTIME_BACKENDS = ["linux-systemd", "local-simulator", "disabled"] as const;
export const RuntimeBackendSchema = z.enum(RUNTIME_BACKENDS);
export type RuntimeBackend = z.infer<typeof RuntimeBackendSchema>;

export const PlatformCapabilitiesDtoSchema = z.object({
  phase: z.enum(["phase-1", "phase-2"]),
  runtimeBackend: RuntimeBackendSchema.default("disabled"),
  hostingMode: z.literal("dedicated"),
  sharedHostingEnabled: z.literal(false),
  dockerExecutorRuntimeAvailable: z.boolean(),
  hostAgentRuntimeAvailable: z.boolean(),
  acmeTlsRuntimeAvailable: z.literal(false),
  sftpAvailable: z.literal(false),
  productionBackupRuntimeAvailable: z.literal(false),
});
export type PlatformCapabilitiesDto = z.infer<typeof PlatformCapabilitiesDtoSchema>;

export const DEFAULT_PLATFORM_CAPABILITIES: PlatformCapabilitiesDto = Object.freeze({
  phase: "phase-1",
  runtimeBackend: "disabled",
  hostingMode: "dedicated",
  sharedHostingEnabled: false,
  dockerExecutorRuntimeAvailable: false,
  hostAgentRuntimeAvailable: false,
  acmeTlsRuntimeAvailable: false,
  sftpAvailable: false,
  productionBackupRuntimeAvailable: false,
});

export interface CreatePlatformCapabilitiesOptions {
  readonly runtimeBackend: RuntimeBackend;
  readonly dockerExecutorRuntimeAvailable?: boolean;
  readonly hostAgentRuntimeAvailable?: boolean;
}

export function createPlatformCapabilities(
  options: CreatePlatformCapabilitiesOptions,
): PlatformCapabilitiesDto {
  const isDisabled = options.runtimeBackend === "disabled";
  return Object.freeze(
    PlatformCapabilitiesDtoSchema.parse({
      phase: isDisabled ? "phase-1" : "phase-2",
      runtimeBackend: options.runtimeBackend,
      hostingMode: "dedicated",
      sharedHostingEnabled: false,
      dockerExecutorRuntimeAvailable: isDisabled
        ? false
        : Boolean(options.dockerExecutorRuntimeAvailable),
      hostAgentRuntimeAvailable: isDisabled
        ? false
        : Boolean(options.hostAgentRuntimeAvailable),
      acmeTlsRuntimeAvailable: false,
      sftpAvailable: false,
      productionBackupRuntimeAvailable: false,
    }),
  );
}

export const OrganizationCapabilitiesDtoSchema = z.object({
  hostingMode: z.enum(["dedicated", "shared"]),
  sharedHostingEnabled: z.literal(false),
  dockerExecutorRuntimeAvailable: z.boolean(),
  hostAgentRuntimeAvailable: z.boolean(),
  acmeTlsRuntimeAvailable: z.literal(false),
  sftpAvailable: z.literal(false),
  productionBackupRuntimeAvailable: z.literal(false),
});
export type OrganizationCapabilitiesDto = z.infer<typeof OrganizationCapabilitiesDtoSchema>;

// Auth & Dev Persona
export const DevPersonaDtoSchema = z.object({
  id: EntityIdSchema,
  email: z.string().email(),
  name: z.string().min(1),
  description: z.string().min(1),
  role: PresetRoleNameSchema,
  organizationId: EntityIdSchema.nullable().optional(),
  globalRoles: z.array(PresetRoleNameSchema),
});
export type DevPersonaDto = z.infer<typeof DevPersonaDtoSchema>;

export const ORGANIZATION_STATUSES = ["active", "suspended", "archived"] as const;
export const OrganizationStatusSchema = z.enum(ORGANIZATION_STATUSES);
export type OrganizationStatus = z.infer<typeof OrganizationStatusSchema>;

export const MeMembershipDtoSchema = z.object({
  id: EntityIdSchema,
  organizationId: EntityIdSchema,
  organizationName: z.string().min(1),
  organizationSlug: z.string().min(1),
  role: PresetRoleNameSchema,
  organizationStatus: OrganizationStatusSchema,
});
export type MeMembershipDto = z.infer<typeof MeMembershipDtoSchema>;

export const MeDtoSchema = z.object({
  user: z.object({
    id: EntityIdSchema,
    email: z.string().email(),
    name: z.string().min(1),
    locale: z.enum(["it", "en"]),
    totpEnabled: z.boolean(),
    mustChangePassword: z.boolean(),
    isServerAdmin: z.boolean(),
  }),
  globalRoles: z.array(PresetRoleNameSchema),
  hostingAdminOrgIds: z.array(EntityIdSchema),
  memberships: z.array(MeMembershipDtoSchema),
  platformCapabilities: PlatformCapabilitiesDtoSchema,
});
export type MeDto = z.infer<typeof MeDtoSchema>;

// Hosts & Allocations
export const HOST_STATUSES = ["ready", "maintenance", "provisioning", "drained", "offline"] as const;
export const HostStatusSchema = z.enum(HOST_STATUSES);
export type HostStatus = z.infer<typeof HostStatusSchema>;

export const HOSTING_MODES = ["dedicated", "shared"] as const;
export const HostingModeSchema = z.enum(HOSTING_MODES);
export type HostingMode = z.infer<typeof HostingModeSchema>;

export const HostDtoSchema = z.object({
  id: EntityIdSchema,
  name: z.string().min(1),
  hostname: z.string().min(1),
  ipv4Address: z.string().ipv4(),
  ipv6Address: z.string().ipv6().nullable().optional(),
  status: HostStatusSchema,
  hostingMode: HostingModeSchema,
  totalCpuMilli: z.number().int().positive(),
  totalMemoryBytes: z.string().regex(/^\d+$/),
  totalStorageBytes: z.string().regex(/^\d+$/),
  securityReviewed: z.boolean(),
  sharedApproved: z.boolean(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type HostDto = z.infer<typeof HostDtoSchema>;

export const UpdateHostModeInputSchema = z.object({
  hostingMode: HostingModeSchema,
  reason: z.string().min(1).optional(),
});
export type UpdateHostModeInput = z.infer<typeof UpdateHostModeInputSchema>;

export const HostMaintenanceInputSchema = z.object({
  action: z.string().min(1),
  reason: z.string().min(1).optional(),
});
export type HostMaintenanceInput = z.infer<typeof HostMaintenanceInputSchema>;

export const HostSecurityInputSchema = z.object({
  policyRef: z.string().min(1),
  reason: z.string().min(1).optional(),
});
export type HostSecurityInput = z.infer<typeof HostSecurityInputSchema>;

export const HOST_ALLOCATION_STATUSES = ["pending", "active", "suspended", "released"] as const;
export const HostAllocationStatusSchema = z.enum(HOST_ALLOCATION_STATUSES);
export type HostAllocationStatus = z.infer<typeof HostAllocationStatusSchema>;

export const HostAllocationDtoSchema = z.object({
  id: EntityIdSchema,
  hostId: EntityIdSchema,
  organizationId: EntityIdSchema,
  status: HostAllocationStatusSchema,
  hostingMode: HostingModeSchema,
  dedicatedScope: z.boolean(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type HostAllocationDto = z.infer<typeof HostAllocationDtoSchema>;

export const CreateHostAllocationInputSchema = z.object({
  hostId: EntityIdSchema,
  organizationId: EntityIdSchema,
  hostingMode: HostingModeSchema.optional().default("dedicated"),
});
export type CreateHostAllocationInput = z.infer<typeof CreateHostAllocationInputSchema>;

// Service Templates
export const ServiceTemplateDtoSchema = z.object({
  id: EntityIdSchema,
  name: z.string().min(1),
  slug: z.string().min(1),
  description: z.string().nullable().optional(),
  category: z.string().min(1),
  defaultImage: z.string().min(1),
  defaultPort: z.number().int().positive().nullable().optional(),
  environmentSchema: z.record(z.string(), z.unknown()),
  defaultConfiguration: z.record(z.string(), z.unknown()),
  approvedForDedicated: z.boolean(),
  approvedForShared: z.boolean(),
  minCpuMilli: z.number().int().positive(),
  minMemoryBytes: z.string().regex(/^\d+$/),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type ServiceTemplateDto = z.infer<typeof ServiceTemplateDtoSchema>;

export const CreateServiceTemplateInputSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  description: z.string().optional(),
  category: z.string().min(1),
  defaultImage: z.string().min(1),
  defaultPort: z.number().int().positive().optional(),
  environmentSchema: z.record(z.string(), z.unknown()).optional().default({}),
  defaultConfiguration: z.record(z.string(), z.unknown()).optional().default({}),
  approvedForDedicated: z.boolean().optional().default(true),
  approvedForShared: z.boolean().optional().default(false),
  minCpuMilli: z.number().int().positive().optional().default(100),
  minMemoryBytes: z.string().regex(/^\d+$/).optional().default("134217728"),
});
export type CreateServiceTemplateInput = z.infer<typeof CreateServiceTemplateInputSchema>;

// Organizations, Members, Quotas
export const OrganizationSummaryDtoSchema = z.object({
  id: EntityIdSchema,
  name: z.string().min(1),
  slug: z.string().min(1),
  status: OrganizationStatusSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type OrganizationSummaryDto = z.infer<typeof OrganizationSummaryDtoSchema>;

export const ResourceQuotaDtoSchema = z.object({
  id: EntityIdSchema,
  organizationId: EntityIdSchema,
  hostAllocationId: EntityIdSchema.nullable().optional(),
  maxSites: z.number().int().nonnegative(),
  maxServices: z.number().int().nonnegative(),
  maxCpuMilli: z.number().int().nonnegative(),
  maxMemoryBytes: z.string().regex(/^\d+$/),
  maxStorageBytes: z.string().regex(/^\d+$/),
  usedSites: z.number().int().nonnegative(),
  usedServices: z.number().int().nonnegative(),
  usedCpuMilli: z.number().int().nonnegative(),
  usedMemoryBytes: z.string().regex(/^\d+$/),
  usedStorageBytes: z.string().regex(/^\d+$/),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type ResourceQuotaDto = z.infer<typeof ResourceQuotaDtoSchema>;

export const OrganizationDetailDtoSchema = OrganizationSummaryDtoSchema.extend({
  capabilities: OrganizationCapabilitiesDtoSchema,
  quotas: ResourceQuotaDtoSchema.nullable().optional(),
  siteCount: z.number().int().nonnegative(),
  serviceCount: z.number().int().nonnegative(),
});
export type OrganizationDetailDto = z.infer<typeof OrganizationDetailDtoSchema>;

export const MemberDtoSchema = z.object({
  id: EntityIdSchema,
  organizationId: EntityIdSchema,
  userId: EntityIdSchema,
  email: z.string().email(),
  name: z.string().min(1),
  role: z.enum(["customer_owner", "customer_collaborator"]),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type MemberDto = z.infer<typeof MemberDtoSchema>;

export const CreateInvitationInputSchema = z.object({
  email: z.string().email(),
  role: z.enum(["customer_owner", "customer_collaborator"]),
});
export type CreateInvitationInput = z.infer<typeof CreateInvitationInputSchema>;

export const QUOTA_RESERVATION_STATUSES = ["pending", "committed", "released"] as const;
export const QuotaReservationStatusSchema = z.enum(QUOTA_RESERVATION_STATUSES);
export type QuotaReservationStatus = z.infer<typeof QuotaReservationStatusSchema>;

export const QuotaReservationDtoSchema = z.object({
  id: EntityIdSchema,
  organizationId: EntityIdSchema,
  resourceQuotaId: EntityIdSchema,
  sites: z.number().int().nonnegative(),
  services: z.number().int().nonnegative(),
  cpuMilli: z.number().int().nonnegative(),
  memoryBytes: z.string().regex(/^\d+$/),
  storageBytes: z.string().regex(/^\d+$/),
  status: QuotaReservationStatusSchema,
  idempotencyKey: z.string().min(1),
  expiresAt: IsoDateTimeSchema,
  createdAt: IsoDateTimeSchema,
});
export type QuotaReservationDto = z.infer<typeof QuotaReservationDtoSchema>;

export const CreateQuotaReservationInputSchema = z.object({
  sites: z.number().int().nonnegative().optional().default(0),
  services: z.number().int().nonnegative().optional().default(0),
  cpuMilli: z.number().int().nonnegative().optional().default(0),
  memoryBytes: z.string().regex(/^\d+$/).optional().default("0"),
  storageBytes: z.string().regex(/^\d+$/).optional().default("0"),
  idempotencyKey: z.string().min(1),
});
export type CreateQuotaReservationInput = z.infer<typeof CreateQuotaReservationInputSchema>;

// Sites, Services, Revisions, Domains
export const DOMAIN_STATUSES = ["pending", "active", "failed"] as const;
export const DomainStatusSchema = z.enum(DOMAIN_STATUSES);
export type DomainStatus = z.infer<typeof DomainStatusSchema>;

export const DomainDtoSchema = z.object({
  id: EntityIdSchema,
  siteId: EntityIdSchema,
  organizationId: EntityIdSchema,
  hostname: z.string().min(1),
  isPrimary: z.boolean(),
  status: DomainStatusSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type DomainDto = z.infer<typeof DomainDtoSchema>;

export const StackRevisionDtoSchema = z.object({
  id: EntityIdSchema,
  serviceInstanceId: EntityIdSchema,
  organizationId: EntityIdSchema,
  revisionNumber: z.number().int().positive(),
  specHash: z.string().length(64),
  declarativeConfig: z.record(z.string(), z.unknown()),
  secretRefs: z.record(z.string(), z.string()),
  resourceLimits: z
    .object({
      cpuMilli: z.number().int().positive(),
      memoryBytes: z.string().regex(/^\d+$/),
    })
    .nullable(),
  authorId: EntityIdSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type StackRevisionDto = z.infer<typeof StackRevisionDtoSchema>;

export const SERVICE_DESIRED_STATUSES = ["running", "stopped"] as const;
export const ServiceDesiredStatusSchema = z.enum(SERVICE_DESIRED_STATUSES);
export type ServiceDesiredStatus = z.infer<typeof ServiceDesiredStatusSchema>;

export const ServiceInstanceDtoSchema = z.object({
  id: EntityIdSchema,
  siteId: EntityIdSchema,
  organizationId: EntityIdSchema,
  serviceTemplateId: EntityIdSchema,
  name: z.string().min(1),
  desiredStatus: ServiceDesiredStatusSchema,
  currentRevisionId: EntityIdSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type ServiceInstanceDto = z.infer<typeof ServiceInstanceDtoSchema>;

export const SITE_STATUSES = ["ready", "deploying", "degraded", "stopped", "maintenance"] as const;
export const SiteStatusSchema = z.enum(SITE_STATUSES);
export type SiteStatus = z.infer<typeof SiteStatusSchema>;

export const DRIFT_STATUSES = ["in_sync", "drifted", "unknown"] as const;
export const DriftStatusSchema = z.enum(DRIFT_STATUSES);
export type DriftStatus = z.infer<typeof DriftStatusSchema>;

export const DriftSummarySchema = z.object({
  totalServices: z.number().int().nonnegative(),
  inSyncCount: z.number().int().nonnegative(),
  driftedCount: z.number().int().nonnegative(),
  unknownCount: z.number().int().nonnegative(),
  overallDriftStatus: DriftStatusSchema,
});
export type DriftSummary = z.infer<typeof DriftSummarySchema>;

export const SiteSummaryDtoSchema = z.object({
  id: EntityIdSchema,
  organizationId: EntityIdSchema,
  hostAllocationId: EntityIdSchema,
  name: z.string().min(1),
  slug: z.string().min(1),
  status: SiteStatusSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type SiteSummaryDto = z.infer<typeof SiteSummaryDtoSchema>;

export const SiteDetailDtoSchema = SiteSummaryDtoSchema.extend({
  services: z.array(ServiceInstanceDtoSchema),
  domains: z.array(DomainDtoSchema),
  driftSummary: DriftSummarySchema,
});
export type SiteDetailDto = z.infer<typeof SiteDetailDtoSchema>;

export const CreateSiteInputSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  hostAllocationId: EntityIdSchema,
  initialDomain: z.string().min(1).optional(),
});
export type CreateSiteInput = z.infer<typeof CreateSiteInputSchema>;

export const CreateServiceInstanceInputSchema = z.object({
  serviceTemplateId: EntityIdSchema,
  name: z.string().min(1),
  desiredStatus: ServiceDesiredStatusSchema.optional().default("running"),
  configuration: z.record(z.string(), z.unknown()),
  secretRefs: z.record(z.string(), z.string()).optional(),
  resourceLimits: z
    .object({
      cpuMilli: z.number().int().positive(),
      memoryBytes: z.string().regex(/^\d+$/),
    })
    .optional(),
});
export type CreateServiceInstanceInput = z.infer<typeof CreateServiceInstanceInputSchema>;

export const CreateStackRevisionInputSchema = z.object({
  declarativeConfig: z.record(z.string(), z.unknown()),
  secretRefs: z.record(z.string(), z.string()).optional(),
  resourceLimits: z
    .object({
      cpuMilli: z.number().int().positive(),
      memoryBytes: z.string().regex(/^\d+$/),
    })
    .optional(),
  reason: z.string().min(1).optional(),
});
export type CreateStackRevisionInput = z.infer<typeof CreateStackRevisionInputSchema>;

export const ServiceLifecycleInputSchema = z.object({
  action: z.enum(["deploy", "restart", "stop"]),
  reason: z.string().min(1).optional(),
});
export type ServiceLifecycleInput = z.infer<typeof ServiceLifecycleInputSchema>;

// Audit
export const AUDIT_ACTOR_TYPES = ["user", "system", "service_account"] as const;
export const AuditActorTypeSchema = z.enum(AUDIT_ACTOR_TYPES);
export type AuditActorType = z.infer<typeof AuditActorTypeSchema>;

export const AuditEventDtoSchema = z.object({
  id: EntityIdSchema,
  actorId: EntityIdSchema.nullable(),
  actorType: AuditActorTypeSchema,
  organizationId: EntityIdSchema.nullable(),
  action: z.string().min(1),
  targetType: z.string().min(1),
  targetId: EntityIdSchema.nullable(),
  ipAddress: z.string().nullable().optional(),
  userAgent: z.string().nullable().optional(),
  details: z.record(z.string(), z.unknown()),
  timestamp: IsoDateTimeSchema,
});
export type AuditEventDto = z.infer<typeof AuditEventDtoSchema>;

// Phase 2 — Encrypted Secrets Metadata (Write-Only) & Host Daemon / Telemetry DTOs
export const SECRET_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const SecretKeySchema = z.string().regex(SECRET_KEY_PATTERN);
export type SecretKey = z.infer<typeof SecretKeySchema>;

export const EncryptedSecretMetadataDtoSchema = z.object({
  id: EntityIdSchema,
  organizationId: EntityIdSchema,
  siteId: EntityIdSchema.nullable(),
  secretKey: SecretKeySchema,
  keyVersion: z.string().min(1),
  version: z.number().int().positive(),
  createdByUserId: EntityIdSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type EncryptedSecretMetadataDto = z.infer<typeof EncryptedSecretMetadataDtoSchema>;

export const UpsertEncryptedSecretInputSchema = z.object({
  secretKey: SecretKeySchema,
  value: z.string().min(1).max(16384),
  siteId: z.string().min(1).max(128).nullable().optional(),
});
export type UpsertEncryptedSecretInput = z.infer<typeof UpsertEncryptedSecretInputSchema>;

export const HOST_DAEMON_COMPONENTS = ["docker_executor", "host_agent"] as const;
export const HostDaemonComponentSchema = z.enum(HOST_DAEMON_COMPONENTS);
export type HostDaemonComponent = z.infer<typeof HostDaemonComponentSchema>;

export const HOST_DAEMON_STATUSES = ["online", "degraded", "offline"] as const;
export const HostDaemonStatusSchema = z.enum(HOST_DAEMON_STATUSES);
export type HostDaemonStatus = z.infer<typeof HostDaemonStatusSchema>;

export const HostDaemonHeartbeatDtoSchema = z.object({
  hostId: EntityIdSchema,
  component: HostDaemonComponentSchema,
  status: HostDaemonStatusSchema,
  version: z.string().min(1),
  lastSeenAt: IsoDateTimeSchema,
  telemetrySnapshot: z.record(z.string(), z.unknown()),
});
export type HostDaemonHeartbeatDto = z.infer<typeof HostDaemonHeartbeatDtoSchema>;

export const HostTelemetryDtoSchema = z.object({
  hostId: EntityIdSchema,
  cpuUsagePercent: z.number().min(0).max(100),
  memoryUsedBytes: z.string().regex(/^\d+$/),
  memoryTotalBytes: z.string().regex(/^\d+$/),
  storageUsedBytes: z.string().regex(/^\d+$/),
  storageTotalBytes: z.string().regex(/^\d+$/),
  uptimeSeconds: z.number().nonnegative(),
  kernelVersion: z.string().min(1),
  dockerEngineReachable: z.boolean(),
  collectedAt: IsoDateTimeSchema,
});
export type HostTelemetryDto = z.infer<typeof HostTelemetryDtoSchema>;


// Login
export const LoginInputSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(1024),
  totpCode: z.string().regex(/^\d{6}$/).optional(),
});
export type LoginInput = z.infer<typeof LoginInputSchema>;

export const LoginResultDtoSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    accessToken: z.string().min(1),
    expiresAt: IsoDateTimeSchema,
    mustChangePassword: z.boolean(),
  }),
  z.object({ status: z.literal("totp_required") }),
]);
export type LoginResultDto = z.infer<typeof LoginResultDtoSchema>;

export const AdminUserDtoSchema = z.object({
  id: EntityIdSchema,
  email: z.string().email(),
  name: z.string().min(1),
  role: z.enum(["server_admin", "customer"]),
  status: z.enum(["active", "disabled"]),
  totpEnabled: z.boolean(),
  mustChangePassword: z.boolean(),
  lockedUntil: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type AdminUserDto = z.infer<typeof AdminUserDtoSchema>;

export const CreateCustomerAccountInputSchema = z.object({
  organizationName: z.string().trim().min(1).max(120),
  ownerEmail: z.string().trim().toLowerCase().email(),
  ownerName: z.string().trim().min(1).max(120),
});
export type CreateCustomerAccountInput = z.infer<typeof CreateCustomerAccountInputSchema>;
