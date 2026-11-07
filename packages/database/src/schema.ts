import {
  type AnyPgColumn,
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
  AuditEventOutcome,
  AuditMetadata,
  CertificateStatus,
  DatabaseEngine,
  DomainVerificationStatus,
  ErrorCode,
  GrantEffect,
  ObservationSource,
  ObservedResourceStatus,
  OperationKind,
  OperationResourceType,
  OperationStepStatus,
  OperationStatus,
  OrganizationStatus,
  OrganizationType,
  PermissionKey,
  ProviderCapabilities,
  ProviderConnectionStatus,
  ResourceHealthStatus,
  ResourceType,
} from "@hosting-panel/contracts";

export type UserStatus = "active" | "disabled";
export type MembershipStatus = "active" | "invited" | "suspended";
export type PermissionRiskLevel = "low" | "medium" | "high" | "critical";
export type MembershipRoleScopeType = "organization" | "resource";
export type DesiredResourceState = "running" | "stopped";

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    issuer: text("issuer").notNull(),
    subject: text("subject").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(true),
    displayName: text("display_name").notNull(),
    status: text("status").$type<UserStatus>().notNull().default("active"),
    isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("users_issuer_subject_unique").on(t.issuer, t.subject),
    unique("users_email_unique").on(t.email),
  ],
);

export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique("organizations_slug_unique"),
  name: text("name").notNull(),
  type: text("type").$type<OrganizationType>().notNull().default("customer"),
  status: text("status").$type<OrganizationStatus>().notNull().default("active"),
  primaryLocale: text("primary_locale").notNull().default("it-IT"),
  parentResellerId: text("parent_reseller_id").references((): AnyPgColumn => organizations.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

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
    status: text("status").$type<MembershipStatus>().notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("memberships_organization_user_unique").on(t.organizationId, t.userId),
    index("idx_memberships_user_id").on(t.userId),
  ],
);

export const roles = pgTable(
  "roles",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    isSystem: boolean("is_system").notNull().default(false),
    version: integer("version").notNull().default(1),
  },
  (t) => [index("idx_roles_organization_id").on(t.organizationId)],
);

export const permissions = pgTable("permissions", {
  key: text("key").$type<PermissionKey>().primaryKey(),
  description: text("description").notNull(),
  riskLevel: text("risk_level").$type<PermissionRiskLevel>().notNull().default("low"),
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
    effect: text("effect").$type<GrantEffect>().notNull().default("allow"),
  },
  (t) => [primaryKey({ name: "role_permissions_pkey", columns: [t.roleId, t.permissionKey] })],
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
    scopeType: text("scope_type")
      .$type<MembershipRoleScopeType>()
      .notNull()
      .default("organization"),
    scopeResourceId: text("scope_resource_id"),
  },
  (t) => [index("idx_membership_roles_membership_id").on(t.membershipId)],
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
    reason: text("reason").notNull(),
    permissionsJson: jsonb("permissions_json").$type<PermissionKey[]>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_support_access_grants_org_operator").on(t.organizationId, t.operatorUserId)],
);

export const quotaAllocations = pgTable("quota_allocations", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .unique("quota_allocations_organization_unique")
    .references(() => organizations.id, { onDelete: "cascade" }),
  planCode: text("plan_code").notNull(),
  serversUsed: integer("servers_used").notNull().default(0),
  serversLimit: integer("servers_limit").notNull().default(0),
  applicationsUsed: integer("applications_used").notNull().default(0),
  applicationsLimit: integer("applications_limit").notNull().default(0),
  databasesUsed: integer("databases_used").notNull().default(0),
  databasesLimit: integer("databases_limit").notNull().default(0),
  domainsUsed: integer("domains_used").notNull().default(0),
  domainsLimit: integer("domains_limit").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const providerInstances = pgTable("provider_instances", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  kind: text("kind").$type<"coolify-v4">().notNull().default("coolify-v4"),
  baseUrl: text("base_url").notNull(),
  status: text("status").$type<ProviderConnectionStatus>().notNull().default("connected"),
  version: text("version"),
  capabilitiesJson: jsonb("capabilities_json").$type<ProviderCapabilities>().notNull(),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const providerConnections = pgTable(
  "provider_connections",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    providerInstanceId: text("provider_instance_id")
      .notNull()
      .references(() => providerInstances.id, { onDelete: "restrict" }),
    teamId: text("team_id").notNull(),
    secretRefRead: text("secret_ref_read").notNull(),
    secretRefWrite: text("secret_ref_write"),
    secretRefDeploy: text("secret_ref_deploy"),
    status: text("status").$type<ProviderConnectionStatus>().notNull().default("connected"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("provider_connections_id_org_unique").on(t.id, t.organizationId),
    index("idx_provider_connections_org_id").on(t.organizationId),
  ],
);

export const serverAllocations = pgTable(
  "server_allocations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    providerConnectionId: text("provider_connection_id").notNull(),
    providerServerId: text("provider_server_id").notNull(),
    name: text("name").notNull(),
    region: text("region").notNull(),
    publicIpv4: text("public_ipv4"),
    status: text("status").$type<ObservedResourceStatus>().notNull().default("unknown"),
    health: text("health").$type<ResourceHealthStatus>().notNull().default("unknown"),
    vcpuCount: integer("vcpu_count").notNull(),
    memoryMb: integer("memory_mb").notNull(),
    diskGb: integer("disk_gb").notNull(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("server_allocations_id_org_unique").on(t.id, t.organizationId),
    foreignKey({
      name: "fk_server_allocations_connection_org",
      columns: [t.providerConnectionId, t.organizationId],
      foreignColumns: [providerConnections.id, providerConnections.organizationId],
    }).onDelete("restrict"),
    index("idx_server_allocations_org_id").on(t.organizationId),
  ],
);

export const operations = pgTable(
  "operations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    resourceType: text("resource_type").$type<OperationResourceType>().notNull(),
    resourceId: text("resource_id").notNull(),
    kind: text("kind").$type<OperationKind>().notNull(),
    status: text("status").$type<OperationStatus>().notNull().default("queued"),
    requestedByUserId: text("requested_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    payloadJson: jsonb("payload_json").$type<Record<string, unknown>>().notNull().default({}),
    providerOperationId: text("provider_operation_id"),
    errorCode: text("error_code").$type<ErrorCode>(),
    errorMessage: text("error_message"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("operations_org_kind_idempotency_unique").on(
      t.organizationId,
      t.kind,
      t.idempotencyKey,
    ),
    index("idx_operations_org_submitted").on(t.organizationId, t.submittedAt),
    index("idx_operations_resource").on(t.organizationId, t.resourceId),
  ],
);

export const hostingResources = pgTable(
  "hosting_resources",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    connectionId: text("connection_id").notNull(),
    serverAllocationId: text("server_allocation_id").notNull(),
    type: text("type").$type<ResourceType>().notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    providerId: text("provider_id").notNull(),
    desiredState: text("desired_state").$type<DesiredResourceState>().notNull().default("running"),
    observedStatus: text("observed_status")
      .$type<ObservedResourceStatus>()
      .notNull()
      .default("unknown"),
    health: text("health").$type<ResourceHealthStatus>().notNull().default("unknown"),
    observedSource: text("observed_source")
      .$type<ObservationSource>()
      .notNull()
      .default("coolify"),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
    lockedByOperationId: text("locked_by_operation_id").references(() => operations.id, {
      onDelete: "set null",
    }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("hosting_resources_connection_provider_unique").on(t.connectionId, t.providerId),
    unique("hosting_resources_id_org_unique").on(t.id, t.organizationId),
    foreignKey({
      name: "fk_hosting_resources_connection_org",
      columns: [t.connectionId, t.organizationId],
      foreignColumns: [providerConnections.id, providerConnections.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_hosting_resources_server_org",
      columns: [t.serverAllocationId, t.organizationId],
      foreignColumns: [serverAllocations.id, serverAllocations.organizationId],
    }).onDelete("restrict"),
    index("idx_hosting_resources_org_type").on(t.organizationId, t.type),
  ],
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
    effect: text("effect").$type<GrantEffect>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "fk_resource_grants_resource_org",
      columns: [t.resourceId, t.organizationId],
      foreignColumns: [hostingResources.id, hostingResources.organizationId],
    }).onDelete("cascade"),
    index("idx_resource_grants_org_principal").on(t.organizationId, t.principalUserId),
  ],
);

export const applications = pgTable("applications", {
  resourceId: text("resource_id")
    .primaryKey()
    .references(() => hostingResources.id, { onDelete: "cascade" }),
  environment: text("environment").notNull().default("production"),
  repositoryUrl: text("repository_url"),
  branch: text("branch"),
  buildPack: text("build_pack").notNull().default("nixpacks"),
  primaryDomain: text("primary_domain"),
  lastDeployedAt: timestamp("last_deployed_at", { withTimezone: true }),
});

export const databases = pgTable("databases", {
  resourceId: text("resource_id")
    .primaryKey()
    .references(() => hostingResources.id, { onDelete: "cascade" }),
  engine: text("engine").$type<DatabaseEngine>().notNull(),
  engineVersion: text("engine_version").notNull(),
  storageAllocatedGb: integer("storage_allocated_gb").notNull(),
  internalHostname: text("internal_hostname"),
  port: integer("port"),
  lastBackupAt: timestamp("last_backup_at", { withTimezone: true }),
});

export const deploymentRecords = pgTable(
  "deployment_records",
  {
    id: text("id").primaryKey(),
    applicationResourceId: text("application_resource_id")
      .notNull()
      .references(() => applications.resourceId, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    operationId: text("operation_id").references(() => operations.id, { onDelete: "set null" }),
    providerDeploymentId: text("provider_deployment_id"),
    commitSha: text("commit_sha"),
    imageTag: text("image_tag"),
    status: text("status").$type<OperationStatus>().notNull(),
    triggeredByUserId: text("triggered_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "fk_deployment_records_resource_org",
      columns: [t.applicationResourceId, t.organizationId],
      foreignColumns: [hostingResources.id, hostingResources.organizationId],
    }).onDelete("cascade"),
    index("idx_deployment_records_app_created").on(t.applicationResourceId, t.createdAt),
  ],
);

export const domains = pgTable(
  "domains",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    applicationResourceId: text("application_resource_id")
      .notNull()
      .references(() => applications.resourceId, { onDelete: "cascade" }),
    hostname: text("hostname").notNull().unique("domains_hostname_unique"),
    isPrimary: boolean("is_primary").notNull().default(false),
    verificationStatus: text("verification_status")
      .$type<DomainVerificationStatus>()
      .notNull()
      .default("pending"),
    httpsEnabled: boolean("https_enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("domains_id_org_unique").on(t.id, t.organizationId),
    foreignKey({
      name: "fk_domains_app_resource_org",
      columns: [t.applicationResourceId, t.organizationId],
      foreignColumns: [hostingResources.id, hostingResources.organizationId],
    }).onDelete("cascade"),
    index("idx_domains_org_id").on(t.organizationId),
  ],
);

export const certificateObservations = pgTable(
  "certificate_observations",
  {
    id: text("id").primaryKey(),
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    hostname: text("hostname").notNull(),
    status: text("status").$type<CertificateStatus>().notNull().default("unknown"),
    issuer: text("issuer"),
    validFrom: timestamp("valid_from", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    source: text("source").$type<ObservationSource>().notNull().default("coolify"),
  },
  (t) => [
    foreignKey({
      name: "fk_certificate_observations_domain_org",
      columns: [t.domainId, t.organizationId],
      foreignColumns: [domains.id, domains.organizationId],
    }).onDelete("cascade"),
    index("idx_certificate_observations_org_id").on(t.organizationId),
  ],
);

export const operationSteps = pgTable(
  "operation_steps",
  {
    id: text("id").primaryKey(),
    operationId: text("operation_id")
      .notNull()
      .references(() => operations.id, { onDelete: "cascade" }),
    stepOrder: integer("step_order").notNull(),
    key: text("key").notNull(),
    label: text("label").notNull(),
    status: text("status").$type<OperationStepStatus>().notNull().default("pending"),
    message: text("message"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    unique("operation_steps_operation_key_unique").on(t.operationId, t.key),
    index("idx_operation_steps_operation_order").on(t.operationId, t.stepOrder),
  ],
);

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    operationId: text("operation_id")
      .notNull()
      .unique("outbox_events_operation_unique")
      .references(() => operations.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    payloadJson: jsonb("payload_json").$type<Record<string, unknown>>().notNull().default({}),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_outbox_events_pending").on(t.publishedAt, t.createdAt)],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id"),
    actorUserId: text("actor_user_id"),
    actorEmail: text("actor_email"),
    impersonatedByUserId: text("impersonated_by_user_id"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    outcome: text("outcome").$type<AuditEventOutcome>().notNull(),
    requestId: text("request_id").notNull(),
    ipAddress: text("ip_address"),
    metadataJson: jsonb("metadata_json").$type<AuditMetadata>().notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_audit_events_org_occurred").on(t.organizationId, t.occurredAt),
    index("idx_audit_events_occurred").on(t.occurredAt),
  ],
);

export const databaseTables = {
  users,
  organizations,
  memberships,
  roles,
  permissions,
  rolePermissions,
  membershipRoles,
  resourceGrants,
  supportAccessGrants,
  quotaAllocations,
  providerInstances,
  providerConnections,
  serverAllocations,
  hostingResources,
  applications,
  databases,
  deploymentRecords,
  domains,
  certificateObservations,
  operations,
  operationSteps,
  outboxEvents,
  auditEvents,
} as const;

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type OrganizationRow = typeof organizations.$inferSelect;
export type NewOrganizationRow = typeof organizations.$inferInsert;
export type MembershipRow = typeof memberships.$inferSelect;
export type RoleRow = typeof roles.$inferSelect;
export type PermissionRow = typeof permissions.$inferSelect;
export type RolePermissionRow = typeof rolePermissions.$inferSelect;
export type MembershipRoleRow = typeof membershipRoles.$inferSelect;
export type ResourceGrantRow = typeof resourceGrants.$inferSelect;
export type SupportAccessGrantRow = typeof supportAccessGrants.$inferSelect;
export type QuotaAllocationRow = typeof quotaAllocations.$inferSelect;
export type ProviderInstanceRow = typeof providerInstances.$inferSelect;
export type ProviderConnectionRow = typeof providerConnections.$inferSelect;
export type ServerAllocationRow = typeof serverAllocations.$inferSelect;
export type HostingResourceRow = typeof hostingResources.$inferSelect;
export type ApplicationRow = typeof applications.$inferSelect;
export type DatabaseRow = typeof databases.$inferSelect;
export type DeploymentRecordRow = typeof deploymentRecords.$inferSelect;
export type DomainRow = typeof domains.$inferSelect;
export type CertificateObservationRow = typeof certificateObservations.$inferSelect;
export type OperationRow = typeof operations.$inferSelect;
export type OperationStepRow = typeof operationSteps.$inferSelect;
export type OutboxEventRow = typeof outboxEvents.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
