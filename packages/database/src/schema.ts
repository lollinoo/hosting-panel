import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import type {
  AuditActorType,
  DomainStatus,
  ErrorCode,
  GrantEffect,
  HostAllocationStatus,
  HostStatus,
  HostingMode,
  OperationKind,
  OperationResourceType,
  OperationStatus,
  OperationStepStatus,
  OrganizationStatus,
  PermissionKey,
  PresetRoleName,
  QuotaReservationStatus,
  ServiceDesiredStatus,
  SiteStatus,
} from "@hosting-panel/contracts";

export const platformInstallations = pgTable("platform_installations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  specVersion: text("spec_version").notNull().default("HCP-SPEC-002"),
  phase: text("phase").notNull().default("phase-1"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const hosts = pgTable(
  "hosts",
  {
    id: text("id").primaryKey(),
    platformInstallationId: text("platform_installation_id")
      .notNull()
      .references(() => platformInstallations.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    hostname: text("hostname").notNull().unique(),
    ipv4Address: text("ipv4_address").notNull(),
    ipv6Address: text("ipv6_address"),
    status: text("status").$type<HostStatus>().notNull().default("ready"),
    hostingMode: text("hosting_mode").$type<HostingMode>().notNull().default("dedicated"),
    totalCpuMilli: integer("total_cpu_milli").notNull(),
    totalMemoryBytes: text("total_memory_bytes").notNull(),
    totalStorageBytes: text("total_storage_bytes").notNull(),
    securityReviewed: boolean("security_reviewed").notNull().default(false),
    sharedApproved: boolean("shared_approved").notNull().default(false),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_hosts_status_mode").on(t.status, t.hostingMode)],
);

export const organizations = pgTable(
  "organizations",
  {
    id: text("id").primaryKey(),
    platformInstallationId: text("platform_installation_id")
      .notNull()
      .references(() => platformInstallations.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    status: text("status").$type<OrganizationStatus>().notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_organizations_slug").on(t.slug)],
);

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  userStatus: text("user_status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const roles = pgTable("roles", {
  id: text("id").primaryKey(),
  name: text("name").$type<PresetRoleName>().notNull().unique(),
  description: text("description").notNull(),
  isPreset: boolean("is_preset").notNull().default(true),
});

export const permissions = pgTable("permissions", {
  key: text("key").$type<PermissionKey>().primaryKey(),
  description: text("description").notNull(),
});

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: text("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionKey: text("permission_key")
      .$type<PermissionKey>()
      .notNull()
      .references(() => permissions.key, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionKey] })],
);

export const memberships = pgTable(
  "memberships",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("uq_memberships_org_user").on(t.organizationId, t.userId),
    index("idx_memberships_user").on(t.userId),
  ],
);

export const membershipRoles = pgTable(
  "membership_roles",
  {
    id: text("id").primaryKey(),
    membershipId: text("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "cascade" }),
    roleId: text("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    scopeType: text("scope_type").notNull().default("organization"),
    scopeResourceId: text("scope_resource_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_membership_roles_membership").on(t.membershipId)],
);

export const hostingAdminScopes = pgTable(
  "hosting_admin_scopes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: text("organization_id"),
    installationId: text("installation_id")
      .notNull()
      .references(() => platformInstallations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_hosting_admin_scopes_user").on(t.userId)],
);

export const supportAccessGrants = pgTable(
  "support_access_grants",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    operatorUserId: text("operator_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    approvedByUserId: text("approved_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    permissions: jsonb("permissions").$type<readonly PermissionKey[]>().notNull(),
    reason: text("reason").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_support_grants_org_operator").on(t.organizationId, t.operatorUserId)],
);

export const resourceGrants = pgTable(
  "resource_grants",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    principalUserId: text("principal_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    resourceId: text("resource_id").notNull(),
    permission: text("permission")
      .$type<PermissionKey>()
      .notNull()
      .references(() => permissions.key, { onDelete: "cascade" }),
    effect: text("effect").$type<GrantEffect>().notNull().default("allow"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_resource_grants_lookup").on(t.organizationId, t.principalUserId, t.resourceId)],
);

export const hostAllocations = pgTable(
  "host_allocations",
  {
    id: text("id").primaryKey(),
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id, { onDelete: "restrict" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    status: text("status").$type<HostAllocationStatus>().notNull().default("pending"),
    hostingMode: text("hosting_mode").$type<HostingMode>().notNull().default("dedicated"),
    dedicatedScope: boolean("dedicated_scope").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("uq_host_allocations_id_org").on(t.id, t.organizationId),
    index("idx_host_allocations_host_status").on(t.hostId, t.status),
  ],
);

export const sites = pgTable(
  "sites",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    hostAllocationId: text("host_allocation_id").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    status: text("status").$type<SiteStatus>().notNull().default("ready"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("uq_sites_id_org").on(t.id, t.organizationId),
    unique("uq_sites_org_slug").on(t.organizationId, t.slug),
    foreignKey({
      columns: [t.hostAllocationId, t.organizationId],
      foreignColumns: [hostAllocations.id, hostAllocations.organizationId],
      name: "fk_sites_host_allocation_org",
    }).onDelete("restrict"),
  ],
);

export const serviceTemplates = pgTable("service_templates", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  category: text("category").notNull(),
  defaultImage: text("default_image").notNull(),
  defaultPort: integer("default_port"),
  environmentSchema: jsonb("environment_schema").notNull().default({}),
  defaultConfiguration: jsonb("default_configuration").notNull().default({}),
  approvedForDedicated: boolean("approved_for_dedicated").notNull().default(true),
  approvedForShared: boolean("approved_for_shared").notNull().default(false),
  minCpuMilli: integer("min_cpu_milli").notNull().default(100),
  minMemoryBytes: text("min_memory_bytes").notNull().default("134217728"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const serviceInstances = pgTable(
  "service_instances",
  {
    id: text("id").primaryKey(),
    siteId: text("site_id").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    serviceTemplateId: text("service_template_id")
      .notNull()
      .references(() => serviceTemplates.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    desiredStatus: text("desired_status").$type<ServiceDesiredStatus>().notNull().default("running"),
    currentRevisionId: text("current_revision_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("uq_service_instances_id_org").on(t.id, t.organizationId),
    foreignKey({
      columns: [t.siteId, t.organizationId],
      foreignColumns: [sites.id, sites.organizationId],
      name: "fk_service_instances_site_org",
    }).onDelete("cascade"),
  ],
);

export const stackRevisions = pgTable(
  "stack_revisions",
  {
    id: text("id").primaryKey(),
    serviceInstanceId: text("service_instance_id").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    revisionNumber: integer("revision_number").notNull(),
    specHash: text("spec_hash").notNull(),
    declarativeConfig: jsonb("declarative_config").notNull(),
    secretRefs: jsonb("secret_refs").notNull().default({}),
    resourceLimits: jsonb("resource_limits"),
    authorId: text("author_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("uq_stack_revisions_service_rev").on(t.serviceInstanceId, t.revisionNumber),
    foreignKey({
      columns: [t.serviceInstanceId, t.organizationId],
      foreignColumns: [serviceInstances.id, serviceInstances.organizationId],
      name: "fk_stack_revisions_service_instance_org",
    }).onDelete("cascade"),
  ],
);

export const dockerResources = pgTable(
  "docker_resources",
  {
    id: text("id").primaryKey(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    serviceInstanceId: text("service_instance_id")
      .notNull()
      .references(() => serviceInstances.id, { onDelete: "cascade" }),
    internalDockerRef: text("internal_docker_ref").notNull(),
    resourceType: text("resource_type").notNull().default("container"),
    status: text("status").notNull().default("running"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_docker_resources_service").on(t.serviceInstanceId),
    index("idx_docker_resources_site").on(t.siteId),
  ],
);

export const observedStates = pgTable("observed_states", {
  id: text("id").primaryKey(),
  serviceInstanceId: text("service_instance_id")
    .notNull()
    .unique()
    .references(() => serviceInstances.id, { onDelete: "cascade" }),
  observedStatus: text("observed_status").notNull(),
  observedRevisionHash: text("observed_revision_hash"),
  outOfBandModified: boolean("out_of_band_modified").notNull().default(false),
  rawState: jsonb("raw_state").notNull().default({}),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const domains = pgTable(
  "domains",
  {
    id: text("id").primaryKey(),
    siteId: text("site_id").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    hostname: text("hostname").notNull().unique(),
    isPrimary: boolean("is_primary").notNull().default(false),
    status: text("status").$type<DomainStatus>().notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.siteId, t.organizationId],
      foreignColumns: [sites.id, sites.organizationId],
      name: "fk_domains_site_org",
    }).onDelete("cascade"),
  ],
);

export const resourceQuotas = pgTable(
  "resource_quotas",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    hostAllocationId: text("host_allocation_id").references(() => hostAllocations.id, {
      onDelete: "set null",
    }),
    maxSites: integer("max_sites").notNull(),
    maxServices: integer("max_services").notNull(),
    maxCpuMilli: integer("max_cpu_milli").notNull(),
    maxMemoryBytes: text("max_memory_bytes").notNull(),
    maxStorageBytes: text("max_storage_bytes").notNull(),
    usedSites: integer("used_sites").notNull().default(0),
    usedServices: integer("used_services").notNull().default(0),
    usedCpuMilli: integer("used_cpu_milli").notNull().default(0),
    usedMemoryBytes: text("used_memory_bytes").notNull().default("0"),
    usedStorageBytes: text("used_storage_bytes").notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_resource_quotas_org").on(t.organizationId)],
);

export const quotaReservations = pgTable(
  "quota_reservations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    resourceQuotaId: text("resource_quota_id")
      .notNull()
      .references(() => resourceQuotas.id, { onDelete: "cascade" }),
    sites: integer("sites").notNull().default(0),
    services: integer("services").notNull().default(0),
    cpuMilli: integer("cpu_milli").notNull().default(0),
    memoryBytes: text("memory_bytes").notNull().default("0"),
    storageBytes: text("storage_bytes").notNull().default("0"),
    status: text("status").$type<QuotaReservationStatus>().notNull().default("pending"),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_quota_reservations_quota_status").on(t.resourceQuotaId, t.status)],
);

export const operations = pgTable(
  "operations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind").$type<OperationKind>().notNull(),
    status: text("status").$type<OperationStatus>().notNull().default("queued"),
    resourceType: text("resource_type").$type<OperationResourceType>().notNull(),
    resourceId: text("resource_id").notNull(),
    requestedByUserId: text("requested_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    idempotencyKey: text("idempotency_key"),
    lockKey: text("lock_key"),
    errorCode: text("error_code").$type<ErrorCode>(),
    errorMessage: text("error_message"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_operations_org_status").on(t.organizationId, t.status),
    index("idx_operations_lock_key").on(t.lockKey),
  ],
);

export const operationSteps = pgTable("operation_steps", {
  id: text("id").primaryKey(),
  operationId: text("operation_id")
    .notNull()
    .references(() => operations.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  label: text("label").notNull(),
  status: text("status").$type<OperationStepStatus>().notNull().default("pending"),
  message: text("message"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: text("id").primaryKey(),
    eventType: text("event_type").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"),
    retryCount: integer("retry_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (t) => [index("idx_outbox_events_status").on(t.status)],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    actorType: text("actor_type").$type<AuditActorType>().notNull().default("user"),
    organizationId: text("organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    details: jsonb("details").notNull().default({}),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_audit_events_org_timestamp").on(t.organizationId, t.timestamp)],
);
