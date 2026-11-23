import {
  type AnyPgColumn,
  bigint,
  boolean,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type {
  AppStackComponentHealth,
  AppStackDeploymentStatus,
  AppStackRetentionPolicy,
  AppStackStatus,
  AppStackTaskRunProblem,
  AppStackTaskRunStatus,
  AppStackTaskSkipReason,
  AppStackTaskTrigger,
  AppStackVolumeStatus,
  AppTemplateParameterEntry,
  AuditActorType,
  BackupCopyStatus,
  BackupKind,
  BackupPolicyScope,
  BackupProblem,
  BackupStatus,
  BackupTargetKind,
  CertChallenge,
  CertProblem,
  CertStatus,
  DnsProvider,
  DnsStatus,
  DomainStatus,
  ErrorCode,
  FirewallFamily,
  GrantEffect,
  HostAllocationStatus,
  HeartbeatRowComponent,
  HostDaemonStatus,
  HostStatus,
  HostingMode,
  OperationKind,
  OperationResourceType,
  OperationStatus,
  OperationStepStatus,
  OrganizationStatus,
  PermissionKey,
  PhpVersion,
  PresetRoleName,
  QuotaReservationStatus,
  ServiceDesiredStatus,
  SiteHostRoute,
  SiteStatus,
  SiteTemplateParameterEntry,
  SiteTemplateSpec,
  SiteTypeKey,
  TerminalEndReason,
  TlsCertMode,
  TlsKeyType,
  TlsVersionProblem,
  TlsVersionStatus,
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
    maxSites: integer("max_sites"),
    maxAppStacks: integer("max_app_stacks"),
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
  passwordHash: text("password_hash"),
  platformRole: text("platform_role").$type<"infrastructure_admin">(),
  locale: text("locale").$type<"it" | "en">().notNull().default("it"),
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  totpCiphertextBase64: text("totp_ciphertext_base64"),
  totpIvBase64: text("totp_iv_base64"),
  totpAuthTagBase64: text("totp_auth_tag_base64"),
  totpEnabledAt: timestamp("totp_enabled_at", { withTimezone: true }),
  totpLastStep: bigint("totp_last_step", { mode: "number" }),
  failedLoginCount: integer("failed_login_count").notNull().default(0),
  totpFailedCount: integer("totp_failed_count").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const userSessions = pgTable(
  "user_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ip: text("ip"),
  },
  (t) => [index("idx_user_sessions_user_id").on(t.userId)],
);

export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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

// Site templates (ADR 0033). The default version and created_by carry no .references(): the circular FK and the user FK live in
// the SQL (0024), which is the source of truth, like tlsCertificates.activeVersionId.
export const siteTemplates = pgTable(
  "site_templates",
  {
    id: text("id").primaryKey(),
    module: text("module").$type<SiteTypeKey>().notNull(),
    name: text("name").notNull(),
    description: text("description"),
    builtIn: boolean("built_in").notNull().default(false),
    enabled: boolean("enabled").notNull().default(false),
    defaultVersionId: text("default_version_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("uq_site_templates_name_active").on(sql`lower(${t.name})`).where(sql`${t.archivedAt} IS NULL`)],
);

export const siteTemplateVersions = pgTable(
  "site_template_versions",
  {
    id: text("id").primaryKey(),
    templateId: text("template_id")
      .notNull()
      .references(() => siteTemplates.id, { onDelete: "restrict" }),
    versionNumber: integer("version_number").notNull(),
    source: text("source").notNull(),
    spec: jsonb("spec").$type<SiteTemplateSpec>().notNull(),
    specHash: text("spec_hash").notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("uq_site_template_versions_number").on(t.templateId, t.versionNumber),
    unique("uq_site_template_versions_id_template").on(t.id, t.templateId),
  ],
);

// Application stacks (ADR-0035). Circular FKs (default/desired/applied version or revision), user FKs and the hostname
// triggers live in the SQL (0025), which is the source of truth, like siteTemplates.defaultVersionId.
export const appTemplates = pgTable(
  "app_templates",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    category: text("category").notNull(),
    builtIn: boolean("built_in").notNull().default(false),
    enabled: boolean("enabled").notNull().default(false),
    defaultVersionId: text("default_version_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("uq_app_templates_slug").on(t.slug)],
);

export const appTemplateVersions = pgTable(
  "app_template_versions",
  {
    id: text("id").primaryKey(),
    templateId: text("template_id").notNull().references(() => appTemplates.id, { onDelete: "restrict" }),
    versionNumber: integer("version_number").notNull(),
    source: text("source").notNull(),
    specVersion: integer("spec_version").notNull(),
    compiledSchema: jsonb("compiled_schema").$type<Readonly<Record<string, unknown>>>().notNull(),
    specHash: text("spec_hash").notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("uq_app_template_versions_number").on(t.templateId, t.versionNumber),
    unique("uq_app_template_versions_id_template").on(t.id, t.templateId),
  ],
);

export const appStacks = pgTable(
  "app_stacks",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    hostAllocationId: text("host_allocation_id").notNull(),
    templateId: text("template_id").notNull(),
    templateVersionId: text("template_version_id").notNull(),
    name: text("name").notNull(),
    status: text("status").$type<AppStackStatus>().notNull().default("draft"),
    desiredRevisionId: text("desired_revision_id"),
    appliedRevisionId: text("applied_revision_id"),
    resourceQuotaId: text("resource_quota_id").references(() => resourceQuotas.id, { onDelete: "set null" }),
    appliedRoutesHash: text("applied_routes_hash"),
    idempotencyKey: text("idempotency_key"),
    requestHash: text("request_hash"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    unique("uq_app_stacks_id_org").on(t.id, t.organizationId),
    foreignKey({
      columns: [t.hostAllocationId, t.organizationId],
      foreignColumns: [hostAllocations.id, hostAllocations.organizationId],
      name: "fk_app_stacks_host_allocation_org",
    }),
    foreignKey({
      columns: [t.templateVersionId, t.templateId],
      foreignColumns: [appTemplateVersions.id, appTemplateVersions.templateId],
      name: "fk_app_stacks_template_version",
    }),
    uniqueIndex("uq_app_stacks_name_live").on(t.organizationId, sql`lower(${t.name})`).where(sql`${t.deletedAt} IS NULL`),
    uniqueIndex("uq_app_stacks_org_idempotency").on(t.organizationId, t.idempotencyKey).where(sql`${t.idempotencyKey} IS NOT NULL`),
    index("idx_app_stacks_org_created").on(t.organizationId, t.createdAt),
    index("idx_app_stacks_template_version").on(t.templateVersionId),
  ],
);

const stackOrg = (name: string, t: { stackId: AnyPgColumn; organizationId: AnyPgColumn }) =>
  foreignKey({ columns: [t.stackId, t.organizationId], foreignColumns: [appStacks.id, appStacks.organizationId], name })
    .onDelete("cascade");

export const appStackParameters = pgTable(
  "app_stack_parameters",
  {
    stackId: text("stack_id").notNull(),
    organizationId: text("organization_id").notNull(),
    parameterKey: text("parameter_key").notNull(),
    publicValue: jsonb("public_value").$type<string | number | boolean>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "app_stack_parameters_pkey", columns: [t.stackId, t.parameterKey] }),
    stackOrg("fk_app_stack_parameters_stack_org", t),
  ],
);

export const appStackSecrets = pgTable(
  "app_stack_secrets",
  {
    id: text("id").primaryKey(),
    stackId: text("stack_id").notNull(),
    organizationId: text("organization_id").notNull(),
    parameterKey: text("parameter_key").notNull(),
    version: integer("version").notNull(),
    ciphertextBase64: text("ciphertext_base64").notNull(),
    ivBase64: text("iv_base64").notNull(),
    authTagBase64: text("auth_tag_base64").notNull(),
    keyVersion: text("key_version").notNull().default("v1"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("uq_app_stack_secrets_version").on(t.stackId, t.parameterKey, t.version),
    stackOrg("fk_app_stack_secrets_stack_org", t),
  ],
);

export const appStackRevisions = pgTable(
  "app_stack_revisions",
  {
    id: text("id").primaryKey(),
    stackId: text("stack_id").notNull(),
    organizationId: text("organization_id").notNull(),
    revisionNumber: integer("revision_number").notNull(),
    templateVersionId: text("template_version_id").notNull().references(() => appTemplateVersions.id),
    plan: jsonb("plan").$type<Readonly<Record<string, unknown>>>().notNull(),
    planHash: text("plan_hash").notNull(),
    parameters: jsonb("parameters").$type<AppTemplateParameterEntry[]>().notNull().default([]),
    componentCount: integer("component_count").notNull(),
    cpuMilli: integer("cpu_milli").notNull(),
    memoryBytes: bigint("memory_bytes", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("uq_app_stack_revisions_number").on(t.stackId, t.revisionNumber),
    unique("uq_app_stack_revisions_id_stack").on(t.id, t.stackId),
    stackOrg("fk_app_stack_revisions_stack_org", t),
  ],
);

export const appStackComponents = pgTable(
  "app_stack_components",
  {
    stackId: text("stack_id").notNull(),
    organizationId: text("organization_id").notNull(),
    componentKey: text("component_key").notNull(),
    health: text("health").$type<AppStackComponentHealth>().notNull().default("unknown"),
    healthObservedAt: timestamp("health_observed_at", { withTimezone: true }),
    appliedRevisionId: text("applied_revision_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "app_stack_components_pkey", columns: [t.stackId, t.componentKey] }),
    stackOrg("fk_app_stack_components_stack_org", t),
    foreignKey({
      columns: [t.appliedRevisionId, t.stackId],
      foreignColumns: [appStackRevisions.id, appStackRevisions.stackId],
      name: "fk_app_stack_components_applied_revision",
    }),
  ],
);

export const appStackVolumes = pgTable(
  "app_stack_volumes",
  {
    stackId: text("stack_id").notNull(),
    organizationId: text("organization_id").notNull(),
    volumeKey: text("volume_key").notNull(),
    retentionPolicy: text("retention_policy").$type<AppStackRetentionPolicy>().notNull().default("retain"),
    status: text("status").$type<AppStackVolumeStatus>().notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "app_stack_volumes_pkey", columns: [t.stackId, t.volumeKey] }),
    stackOrg("fk_app_stack_volumes_stack_org", t),
  ],
);

export const appStackDomains = pgTable(
  "app_stack_domains",
  {
    id: text("id").primaryKey(),
    stackId: text("stack_id").notNull(),
    organizationId: text("organization_id").notNull(),
    componentKey: text("component_key").notNull(),
    internalPort: integer("internal_port").notNull(),
    hostname: text("hostname").notNull(),
    status: text("status").$type<DomainStatus>().notNull().default("pending"),
    dnsStatus: text("dns_status").$type<DnsStatus>().notNull().default("unchecked"),
    dnsObserved: jsonb("dns_observed").$type<{ a: string[]; aaaa: string[] }>().notNull().default({ a: [], aaaa: [] }),
    dnsCheckedAt: timestamp("dns_checked_at", { withTimezone: true }),
    dnsNextCheckAt: timestamp("dns_next_check_at", { withTimezone: true }).notNull().defaultNow(),
    dnsAttempts: integer("dns_attempts").notNull().default(0),
    certStatus: text("cert_status").$type<CertStatus>().notNull().default("none"),
    certProblem: text("cert_problem").$type<CertProblem>(),
    certChallenge: text("cert_challenge").$type<CertChallenge>().notNull().default("http-01"),
    certRequestedAt: timestamp("cert_requested_at", { withTimezone: true }),
    certRetryAt: timestamp("cert_retry_at", { withTimezone: true }),
    certAttempts: integer("cert_attempts").notNull().default(0),
    certExpiresAt: timestamp("cert_expires_at", { withTimezone: true }),
    certTrusted: boolean("cert_trusted").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("uq_app_stack_domains_hostname").on(t.hostname),
    stackOrg("fk_app_stack_domains_stack_org", t),
    foreignKey({
      columns: [t.stackId, t.componentKey],
      foreignColumns: [appStackComponents.stackId, appStackComponents.componentKey],
      name: "fk_app_stack_domains_component",
    }),
    index("idx_app_stack_domains_stack").on(t.stackId),
    index("idx_app_stack_domains_dns_due").on(t.dnsNextCheckAt),
  ],
);

export const appStackDeployments = pgTable(
  "app_stack_deployments",
  {
    id: text("id").primaryKey(),
    stackId: text("stack_id").notNull(),
    organizationId: text("organization_id").notNull(),
    operationId: text("operation_id").notNull(),
    revisionId: text("revision_id"),
    status: text("status").$type<AppStackDeploymentStatus>().notNull().default("queued"),
    problem: text("problem"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    unique("uq_app_stack_deployments_operation").on(t.operationId),
    stackOrg("fk_app_stack_deployments_stack_org", t),
    foreignKey({
      columns: [t.revisionId, t.stackId],
      foreignColumns: [appStackRevisions.id, appStackRevisions.stackId],
      name: "fk_app_stack_deployments_revision",
    }),
    index("idx_app_stack_deployments_stack").on(t.stackId, t.startedAt),
  ],
);

// Tasks of applications (0031, ADR-0042). No schedule row = the task never runs by itself.
export const appStackTaskSchedules = pgTable(
  "app_stack_task_schedules",
  {
    stackId: text("stack_id").notNull(),
    organizationId: text("organization_id").notNull(),
    taskKey: text("task_key").notNull(),
    frequency: text("frequency").$type<"hourly" | "daily" | "weekly">().notNull(),
    hourUtc: integer("hour_utc"),
    weekday: integer("weekday"),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
    changedBy: text("changed_by").references(() => users.id, { onDelete: "set null" }),
    servedSlotAt: timestamp("served_slot_at", { withTimezone: true }),
    skippedSlotAt: timestamp("skipped_slot_at", { withTimezone: true }),
    skipReason: text("skip_reason").$type<AppStackTaskSkipReason>(),
  },
  (t) => [
    primaryKey({ name: "app_stack_task_schedules_pkey", columns: [t.stackId, t.taskKey] }),
    stackOrg("fk_app_stack_task_schedules_stack_org", t),
  ],
);

// What a run printed (masked and bounded by the executor) lives only in `output`.
export const appStackTaskRuns = pgTable(
  "app_stack_task_runs",
  {
    id: text("id").primaryKey(),
    stackId: text("stack_id").notNull(),
    organizationId: text("organization_id").notNull(),
    taskKey: text("task_key").notNull(),
    componentKey: text("component_key").notNull(),
    trigger: text("run_trigger").$type<AppStackTaskTrigger>().notNull(),
    requestedBy: text("requested_by").references(() => users.id, { onDelete: "set null" }),
    slotAt: timestamp("slot_at", { withTimezone: true }),
    operationId: text("operation_id").notNull(),
    status: text("status").$type<AppStackTaskRunStatus>().notNull().default("queued"),
    problem: text("problem").$type<AppStackTaskRunProblem>(),
    exitCode: integer("exit_code"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    output: text("output").notNull().default(""),
    outputTruncated: boolean("output_truncated").notNull().default(false),
  },
  (t) => [
    unique("uq_app_stack_task_runs_operation").on(t.operationId),
    stackOrg("fk_app_stack_task_runs_stack_org", t),
    index("idx_app_stack_task_runs_task").on(t.stackId, t.taskKey, t.requestedAt),
    uniqueIndex("uq_app_stack_task_runs_slot").on(t.stackId, t.taskKey, t.slotAt).where(sql`${t.slotAt} IS NOT NULL`),
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
    phpVersion: text("php_version").$type<PhpVersion>(),
    appliedRoutesHash: text("applied_routes_hash"),
    appliedRoutes: jsonb("applied_routes").$type<SiteHostRoute[] | null>(),
    siteUrl: text("wordpress_url"),
    siteType: text("site_type"),
    // NULL = the built-in WordPress template, version 1 (sites that predate site templates); no .references(): the SQL FK is the source of truth.
    templateVersionId: text("template_version_id"),
    templateParameters: jsonb("template_parameters").$type<SiteTemplateParameterEntry[] | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("uq_sites_id_org").on(t.id, t.organizationId),
    unique("uq_sites_org_slug").on(t.organizationId, t.slug),
    index("idx_sites_template_version").on(t.templateVersionId).where(sql`${t.templateVersionId} IS NOT NULL`),
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
    }).onUpdate("cascade").onDelete("cascade"),
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
    }).onUpdate("cascade").onDelete("cascade"),
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
    dnsStatus: text("dns_status").$type<DnsStatus>().notNull().default("unchecked"),
    dnsObserved: jsonb("dns_observed").$type<{ a: string[]; aaaa: string[] }>().notNull().default({ a: [], aaaa: [] }),
    dnsCheckedAt: timestamp("dns_checked_at", { withTimezone: true }),
    dnsNextCheckAt: timestamp("dns_next_check_at", { withTimezone: true }).notNull().defaultNow(),
    dnsAttempts: integer("dns_attempts").notNull().default(0),
    certStatus: text("cert_status").$type<CertStatus>().notNull().default("none"),
    certProblem: text("cert_problem").$type<CertProblem>(),
    certChallenge: text("cert_challenge").$type<CertChallenge>().notNull().default("http-01"),
    certRequestedAt: timestamp("cert_requested_at", { withTimezone: true }),
    certRetryAt: timestamp("cert_retry_at", { withTimezone: true }),
    certAttempts: integer("cert_attempts").notNull().default(0),
    certExpiresAt: timestamp("cert_expires_at", { withTimezone: true }),
    certTrusted: boolean("cert_trusted").notNull().default(true),
    // HCP-SPEC-004 (0021): 'manual' serves an imported certificate version. The composite FK
    // fk_domains_manual_cert_version_org (manual_certificate_version_id, organization_id) is SQL-only.
    certMode: text("cert_mode").$type<TlsCertMode>().notNull().default("acme"),
    manualCertificateVersionId: text("manual_certificate_version_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.siteId, t.organizationId],
      foreignColumns: [sites.id, sites.organizationId],
      name: "fk_domains_site_org",
    }).onUpdate("cascade").onDelete("cascade"),
    uniqueIndex("uq_domains_one_primary_per_site").on(t.siteId).where(sql`${t.isPrimary}`),
    index("idx_domains_dns_due").on(t.dnsNextCheckAt),
    index("idx_domains_manual_cert_version")
      .on(t.manualCertificateVersionId)
      .where(sql`${t.manualCertificateVersionId} IS NOT NULL`),
  ],
);

// HCP-SPEC-004 (0021): organization-scoped imported TLS certificates. The key lives encrypted on the version row
// (AAD <org>:*:tls:<certificate>:<version>). There is no deleted_at: a delete removes the key ciphertext too.
// The circular FK fk_tls_certificates_active_version (active_version_id, id) is SQL-only, like the domain FK above.
export const tlsCertificates = pgTable(
  "tls_certificates",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdForSiteId: text("created_for_site_id"),
    activeVersionId: text("active_version_id"),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("uq_tls_certificates_id_org").on(t.id, t.organizationId),
    index("idx_tls_certificates_org").on(t.organizationId),
    index("idx_tls_certificates_created_for_site")
      .on(t.createdForSiteId)
      .where(sql`${t.createdForSiteId} IS NOT NULL`),
    // SQL: ON UPDATE NO ACTION ON DELETE SET NULL (created_for_site_id) — only the site column is cleared.
    foreignKey({
      columns: [t.createdForSiteId, t.organizationId],
      foreignColumns: [sites.id, sites.organizationId],
      name: "fk_tls_certificates_site_org",
    }).onUpdate("no action").onDelete("set null"),
  ],
);

// Version material is immutable (trigger trg_prevent_tls_certificate_versions_mutation); only the lifecycle
// columns (status, publish_generation, last_error_code, last_checked_at, activated_at) change.
export const tlsCertificateVersions = pgTable(
  "tls_certificate_versions",
  {
    id: text("id").primaryKey(),
    certificateId: text("certificate_id").notNull(),
    organizationId: text("organization_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    leafPem: text("leaf_pem").notNull(),
    chainPem: text("chain_pem").notNull(),
    keyCiphertextBase64: text("key_ciphertext_base64").notNull(),
    keyIvBase64: text("key_iv_base64").notNull(),
    keyAuthTagBase64: text("key_auth_tag_base64").notNull(),
    keyVersion: text("key_version").notNull().default("v1"),
    subject: text("subject").notNull(),
    issuer: text("issuer").notNull(),
    serialNumber: text("serial_number").notNull(),
    fingerprintSha256: text("fingerprint_sha256").notNull(),
    notBefore: timestamp("not_before", { withTimezone: true }).notNull(),
    notAfter: timestamp("not_after", { withTimezone: true }).notNull(),
    sanDns: jsonb("san_dns").$type<string[]>().notNull(),
    keyType: text("key_type").$type<TlsKeyType>().notNull(),
    keyBits: integer("key_bits").notNull(),
    status: text("status").$type<TlsVersionStatus>().notNull().default("pending"),
    publishGeneration: bigint("publish_generation", { mode: "number" }).notNull().default(0),
    lastErrorCode: text("last_error_code").$type<TlsVersionProblem>(),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    idempotencyKey: text("idempotency_key"),
    requestHash: text("request_hash"),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("uq_tls_certificate_versions_id_org").on(t.id, t.organizationId),
    unique("uq_tls_certificate_versions_id_cert").on(t.id, t.certificateId),
    unique("uq_tls_certificate_versions_number").on(t.certificateId, t.versionNumber),
    uniqueIndex("uq_tls_certificate_versions_org_fingerprint").on(t.organizationId, t.fingerprintSha256),
    uniqueIndex("uq_tls_certificate_versions_org_idempotency")
      .on(t.organizationId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
    index("idx_tls_certificate_versions_not_after").on(t.notAfter),
    index("idx_tls_certificate_versions_org_created").on(t.organizationId, t.createdAt),
    foreignKey({
      columns: [t.certificateId, t.organizationId],
      foreignColumns: [tlsCertificates.id, tlsCertificates.organizationId],
      name: "fk_tls_certificate_versions_cert_org",
    }).onUpdate("no action").onDelete("cascade"),
  ],
);

// One server-wide counter for the manifest hp-manual-certificates.yml; the single row is locked to serialise publishes.
export const tlsPublishState = pgTable("tls_publish_state", {
  id: text("id").primaryKey(),
  desiredGeneration: bigint("desired_generation", { mode: "number" }).notNull().default(0),
  confirmedGeneration: bigint("confirmed_generation", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

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
    // sha-256 hex of the canonical request: the same Idempotency-Key with another payload is refused (0021).
    requestHash: text("request_hash"),
    lockKey: text("lock_key"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
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
    index("idx_operations_resource_submitted").on(t.resourceId, t.submittedAt),
    index("idx_operations_org_submitted").on(t.organizationId, t.submittedAt),
  ],
);

export const operationSteps = pgTable(
  "operation_steps",
  {
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
  },
  (t) => [index("idx_operation_steps_operation").on(t.operationId)],
);

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
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (t) => [index("idx_outbox_events_status").on(t.status)],
);

export const schemaMigrations = pgTable("schema_migrations", {
  filename: text("filename").primaryKey(),
  appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
});

export const encryptedSecrets = pgTable(
  "encrypted_secrets",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    siteId: text("site_id"),
    secretKey: text("secret_key").notNull(),
    ciphertextBase64: text("ciphertext_base64").notNull(),
    ivBase64: text("iv_base64").notNull(),
    authTagBase64: text("auth_tag_base64").notNull(),
    keyVersion: text("key_version").notNull().default("v1"),
    version: integer("version").notNull().default(1),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("uq_encrypted_secrets_id_org").on(t.id, t.organizationId),
    foreignKey({
      columns: [t.siteId, t.organizationId],
      foreignColumns: [sites.id, sites.organizationId],
      name: "fk_encrypted_secrets_site_org",
    }).onUpdate("cascade").onDelete("cascade"),
    index("idx_encrypted_secrets_org_site").on(t.organizationId, t.siteId),
  ],
);

export const hostAgentHeartbeats = pgTable(
  "host_agent_heartbeats",
  {
    id: text("id").primaryKey(),
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id, { onDelete: "cascade" }),
    component: text("component").$type<HeartbeatRowComponent>().notNull(),
    status: text("status").$type<HostDaemonStatus>().notNull(),
    version: text("version").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    telemetrySnapshot: jsonb("telemetry_snapshot").notNull().default({}),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("uq_host_agent_heartbeats_host_component").on(t.hostId, t.component),
    index("idx_host_agent_heartbeats_host").on(t.hostId),
  ],
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
  (t) => [
    index("idx_audit_events_org_timestamp").on(t.organizationId, t.timestamp),
    index("idx_audit_events_timestamp_id").on(t.timestamp, t.id),
  ],
);

export const siteDatabases = pgTable(
  "site_databases",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    siteId: text("site_id").notNull(),
    dbName: text("db_name").notNull().unique(),
    dbUser: text("db_user").notNull().unique(),
    passwordSecretId: text("password_secret_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.siteId, t.organizationId],
      foreignColumns: [sites.id, sites.organizationId],
      name: "fk_site_databases_site_org",
    })
      .onUpdate("cascade")
      .onDelete("cascade"),
    index("idx_site_databases_site").on(t.organizationId, t.siteId),
  ],
);

export const siteSftpUsers = pgTable(
  "site_sftp_users",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    siteId: text("site_id").notNull(),
    username: text("username").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.siteId, t.organizationId],
      foreignColumns: [sites.id, sites.organizationId],
      name: "fk_site_sftp_users_site_org",
    })
      .onUpdate("cascade")
      .onDelete("cascade"),
    index("idx_site_sftp_users_site").on(t.organizationId, t.siteId),
  ],
);

export const mailRelaySettings = pgTable("mail_relay_settings", {
  id: text("id").primaryKey(),
  host: text("host").notNull(),
  port: integer("port").notNull(),
  username: text("username").notNull(),
  senderDomain: text("sender_domain").notNull(),
  passwordCiphertextBase64: text("password_ciphertext_base64").notNull(),
  passwordIvBase64: text("password_iv_base64").notNull(),
  passwordAuthTagBase64: text("password_auth_tag_base64").notNull(),
  passwordKeyVersion: text("password_key_version").notNull().default("v1"),
  updatedByUserId: text("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const dnsProviderSettings = pgTable("dns_provider_settings", {
  id: text("id").primaryKey(),
  provider: text("provider").$type<DnsProvider>().notNull(),
  credentialNames: jsonb("credential_names").$type<string[]>().notNull().default([]),
  credentialsCiphertextBase64: text("credentials_ciphertext_base64").notNull(),
  credentialsIvBase64: text("credentials_iv_base64").notNull(),
  credentialsAuthTagBase64: text("credentials_auth_tag_base64").notNull(),
  credentialsKeyVersion: text("credentials_key_version").notNull().default("v1"),
  updatedByUserId: text("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const backupSettings = pgTable("backup_settings", {
  id: text("id").primaryKey(),
  endpoint: text("endpoint").notNull(),
  region: text("region").notNull(),
  bucket: text("bucket").notNull(),
  prefix: text("prefix").notNull().default(""),
  accessKeyId: text("access_key_id").notNull(),
  secretAccessKeyCiphertextBase64: text("secret_access_key_ciphertext_base64").notNull(),
  secretAccessKeyIvBase64: text("secret_access_key_iv_base64").notNull(),
  secretAccessKeyAuthTagBase64: text("secret_access_key_auth_tag_base64").notNull(),
  secretAccessKeyKeyVersion: text("secret_access_key_key_version").notNull().default("v1"),
  scheduleHourUtc: integer("schedule_hour_utc").notNull().default(2),
  retentionDays: integer("retention_days").notNull().default(14),
  lastNightlyRunOn: date("last_nightly_run_on", { mode: "string" }),
  nightlyRunStartedAt: timestamp("nightly_run_started_at", { withTimezone: true }),
  lastTestAt: timestamp("last_test_at", { withTimezone: true }),
  lastTestOutcome: text("last_test_outcome").$type<"ok" | "failed">(),
  lastTestProblem: text("last_test_problem").$type<BackupProblem>(),
  lastPanelBackupAt: timestamp("last_panel_backup_at", { withTimezone: true }),
  lastPanelBackupStatus: text("last_panel_backup_status").$type<"succeeded" | "failed">(),
  lastPanelBackupProblem: text("last_panel_backup_problem").$type<BackupProblem>(),
  updatedByUserId: text("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// HCP-SPEC-004 (0022): where a backup is written. The legacy S3 target (legacy_settings) keeps reading the untouched
// backup_settings row; new S3 targets hold their own encrypted secret (AAD platform:*:HP_BACKUP_TARGET_S3_SECRET:<id>).
// s3LocationKey = hp_s3_location_key(endpoint, bucket, prefix) (SQL function of 0022): the canonical restic location that
// the unique index uq_backup_targets_s3_location compares. The targets service sets it on every insert and update.
export const backupTargets = pgTable(
  "backup_targets",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<BackupTargetKind>().notNull(),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    legacySettings: boolean("legacy_settings").notNull().default(false),
    customerSelectable: boolean("customer_selectable").notNull().default(false),
    configJson: jsonb("config_json").$type<Record<string, unknown>>().notNull().default({}),
    s3LocationKey: text("s3_location_key"),
    s3SecretCiphertextBase64: text("s3_secret_ciphertext_base64"),
    s3SecretIvBase64: text("s3_secret_iv_base64"),
    s3SecretAuthTagBase64: text("s3_secret_auth_tag_base64"),
    s3SecretKeyVersion: text("s3_secret_key_version"),
    retentionDays: integer("retention_days"),
    lastTestAt: timestamp("last_test_at", { withTimezone: true }),
    lastTestOutcome: text("last_test_outcome").$type<"ok" | "failed">(),
    lastTestProblem: text("last_test_problem").$type<BackupProblem>(),
    lastTestAvailableBytes: bigint("last_test_available_bytes", { mode: "number" }),
    lastTestTotalBytes: bigint("last_test_total_bytes", { mode: "number" }),
    localRoot: text("local_root"),
    initializedAt: timestamp("initialized_at", { withTimezone: true }),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("uq_backup_targets_one_local").on(t.kind).where(sql`${t.kind} = 'local' AND ${t.archivedAt} IS NULL`),
    uniqueIndex("uq_backup_targets_one_legacy").on(t.legacySettings).where(sql`${t.legacySettings}`),
    uniqueIndex("uq_backup_targets_s3_location").on(t.s3LocationKey).where(sql`${t.kind} = 's3' AND ${t.archivedAt} IS NULL`),
  ],
);

export const siteBackups = pgTable(
  "site_backups",
  {
    id: text("id").primaryKey(),
    siteId: text("site_id").notNull(),
    kind: text("kind").$type<BackupKind>().notNull(),
    status: text("status").$type<BackupStatus>().notNull(),
    operationId: text("operation_id").unique(),
    snapshotId: text("snapshot_id"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    problem: text("problem").$type<BackupProblem>(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    siteUrl: text("site_url"),
    restoreOperationId: text("restore_operation_id"),
    restoreStatus: text("restore_status").$type<"running" | "succeeded" | "failed">(),
    restoreProblem: text("restore_problem").$type<BackupProblem>(),
    restoredAt: timestamp("restored_at", { withTimezone: true }),
    archiveOperationId: text("archive_operation_id"),
    archiveStatus: text("archive_status").$type<"preparing" | "ready" | "failed">(),
    archiveProblem: text("archive_problem").$type<BackupProblem>(),
    archiveReadyUntil: timestamp("archive_ready_until", { withTimezone: true }),
    // 0022: the target a restore / a download archive was taken from (NULL = the default target).
    restoreTargetId: text("restore_target_id").references(() => backupTargets.id, { onDelete: "set null" }),
    archiveTargetId: text("archive_target_id").references(() => backupTargets.id, { onDelete: "set null" }),
  },
  (t) => [index("idx_site_backups_site_started").on(t.siteId, t.startedAt)],
);

// The nightly run state (cursor, lock) of the default_site scope moved here from backup_settings, so an install with
// local targets only still schedules backups. 'site' rows choose targets only (hour and retention stay NULL).
export const backupPolicies = pgTable(
  "backup_policies",
  {
    id: text("id").primaryKey(),
    scope: text("scope").$type<BackupPolicyScope>().notNull(),
    siteId: text("site_id").references(() => sites.id, { onDelete: "cascade" }),
    scheduleHourUtc: integer("schedule_hour_utc"),
    retentionDays: integer("retention_days"),
    enabled: boolean("enabled").notNull().default(true),
    lastNightlyRunOn: date("last_nightly_run_on", { mode: "string" }),
    nightlyRunStartedAt: timestamp("nightly_run_started_at", { withTimezone: true }),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_backup_policies_scope").on(t.scope).where(sql`${t.siteId} IS NULL`),
    uniqueIndex("uq_backup_policies_site").on(t.siteId).where(sql`${t.siteId} IS NOT NULL`),
  ],
);

// At most two targets per policy (priority 1..2); a referenced target is archived, never deleted (ON DELETE RESTRICT).
export const backupPolicyTargets = pgTable(
  "backup_policy_targets",
  {
    policyId: text("policy_id")
      .notNull()
      .references(() => backupPolicies.id, { onDelete: "cascade" }),
    targetId: text("target_id")
      .notNull()
      .references(() => backupTargets.id, { onDelete: "restrict" }),
    priority: integer("priority").notNull(),
    required: boolean("required").notNull().default(true),
  },
  (t) => [
    primaryKey({ columns: [t.policyId, t.targetId] }),
    unique("uq_backup_policy_targets_priority").on(t.policyId, t.priority),
    index("idx_backup_policy_targets_target").on(t.targetId),
  ],
);

// One row per target a logical backup was written to (site_backups keeps the primary copy's snapshot for the previous release).
export const siteBackupCopies = pgTable(
  "site_backup_copies",
  {
    id: text("id").primaryKey(),
    backupId: text("backup_id")
      .notNull()
      .references(() => siteBackups.id, { onDelete: "cascade" }),
    targetId: text("target_id")
      .notNull()
      .references(() => backupTargets.id, { onDelete: "restrict" }),
    priority: integer("priority").notNull().default(1),
    required: boolean("required").notNull().default(true),
    jobId: text("job_id"),
    status: text("status").$type<BackupCopyStatus>().notNull(),
    snapshotId: text("snapshot_id"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    problem: text("problem").$type<BackupProblem>(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    unique("uq_site_backup_copies_backup_target").on(t.backupId, t.targetId),
    unique("uq_site_backup_copies_backup_priority").on(t.backupId, t.priority),
    uniqueIndex("uq_site_backup_copies_job").on(t.jobId).where(sql`${t.jobId} IS NOT NULL`),
    index("idx_site_backup_copies_target_status").on(t.targetId, t.status),
  ],
);

export const panelBackupCopies = pgTable(
  "panel_backup_copies",
  {
    id: text("id").primaryKey(),
    operationId: text("operation_id")
      .notNull()
      .references(() => operations.id, { onDelete: "cascade" }),
    targetId: text("target_id")
      .notNull()
      .references(() => backupTargets.id, { onDelete: "restrict" }),
    priority: integer("priority").notNull().default(1),
    required: boolean("required").notNull().default(true),
    jobId: text("job_id"),
    status: text("status").$type<BackupCopyStatus>().notNull(),
    snapshotId: text("snapshot_id"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    problem: text("problem").$type<BackupProblem>(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    unique("uq_panel_backup_copies_operation_target").on(t.operationId, t.targetId),
    unique("uq_panel_backup_copies_operation_priority").on(t.operationId, t.priority),
    uniqueIndex("uq_panel_backup_copies_job").on(t.jobId).where(sql`${t.jobId} IS NOT NULL`),
    index("idx_panel_backup_copies_target_started").on(t.targetId, t.startedAt.desc()),
  ],
);

export const siteWordpressState = pgTable(
  "site_wordpress_state",
  {
    siteId: text("site_id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    state: jsonb("state").$type<unknown>(),
    lastUpdate: jsonb("last_update").$type<unknown>(),
    lastImport: jsonb("last_import").$type<unknown>(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.siteId, t.organizationId],
      foreignColumns: [sites.id, sites.organizationId],
      name: "fk_site_wordpress_state_site_org",
    })
      .onUpdate("cascade")
      .onDelete("cascade"),
  ],
);

// No foreign keys: the row and its audit outlive the site and the user.
export const adminTerminalSessions = pgTable(
  "admin_terminal_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    siteId: text("site_id").notNull(),
    organizationId: text("organization_id").notNull(),
    containerName: text("container_name").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closeReason: text("close_reason").$type<TerminalEndReason>(),
  },
  (t) => [index("idx_admin_terminal_sessions_open").on(t.openedAt).where(sql`${t.closedAt} IS NULL`)],
);

// No CHECK on name: the safe list lives in the contracts and may change without a migration.
export const firewallOpenPorts = pgTable("firewall_open_ports", { name: text("name").primaryKey() });
export const firewallBlocks = pgTable("firewall_blocks", {
  id: text("id").primaryKey(),
  family: text("family").notNull().$type<FirewallFamily>(),
  cidr: text("cidr").notNull().unique(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
