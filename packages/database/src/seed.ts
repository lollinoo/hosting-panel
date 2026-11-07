import { sql } from "drizzle-orm";
import {
  AuditMetadataSchema,
  DEFAULT_COOLIFY_V4_CAPABILITIES,
  isMutatingPermission,
  PERMISSION_KEYS,
  type PermissionKey,
  PRESET_ROLE_NAMES,
  PRESET_ROLE_PERMISSIONS,
  type PresetRoleName,
} from "@hosting-panel/contracts";
import type { HostingPanelDatabase } from "./client.js";
import {
  applications,
  auditEvents,
  certificateObservations,
  databases,
  deploymentRecords,
  domains,
  hostingResources,
  membershipRoles,
  memberships,
  organizations,
  type PermissionRiskLevel,
  permissions,
  providerConnections,
  providerInstances,
  quotaAllocations,
  resourceGrants,
  rolePermissions,
  roles,
  serverAllocations,
  users,
} from "./schema.js";

export const DEFAULT_DEMO_COOLIFY_BASE_URL = "http://127.0.0.1:4101";
export const DEFAULT_DEMO_OIDC_ISSUER = "http://127.0.0.1:4000/oidc";

export const DEMO_IDS = Object.freeze({
  organizations: Object.freeze({
    acme: "org_acme",
    beta: "org_beta",
    legacy: "org_legacy",
  }),
  users: Object.freeze({
    elena: "usr_elena",
    marco: "usr_marco",
    giulia: "usr_giulia",
    luca: "usr_luca",
    admin: "usr_admin",
  }),
  roles: Object.freeze({
    customer_owner: "role_customer_owner",
    hosting_manager: "role_hosting_manager",
    developer: "role_developer",
    database_manager: "role_database_manager",
    billing_manager: "role_billing_manager",
    viewer: "role_viewer",
    platform_admin: "role_platform_admin",
  }) satisfies Readonly<Record<PresetRoleName, string>>,
  memberships: Object.freeze({
    elenaAcme: "mbr_elena_acme",
    elenaBeta: "mbr_elena_beta",
    elenaLegacy: "mbr_elena_legacy",
    marcoAcme: "mbr_marco_acme",
    giuliaAcme: "mbr_giulia_acme",
    lucaBeta: "mbr_luca_beta",
  }),
  membershipRoles: Object.freeze({
    elenaAcmeOwner: "mrole_elena_acme_owner",
    elenaBetaViewer: "mrole_elena_beta_viewer",
    elenaLegacyOwner: "mrole_elena_legacy_owner",
    marcoAcmeStorefrontDev: "mrole_marco_acme_storefront_dev",
    giuliaAcmeViewer: "mrole_giulia_acme_viewer",
    lucaBetaOwner: "mrole_luca_beta_owner",
  }),
  resourceGrants: Object.freeze({
    marcoStorefrontRead: "rgrant_marco_storefront_read",
    marcoStorefrontDeploy: "rgrant_marco_storefront_deploy",
    marcoStorefrontRestart: "rgrant_marco_storefront_restart",
    marcoStorefrontLogs: "rgrant_marco_storefront_logs",
  }),
  providers: Object.freeze({
    coolifyLab: "prv_coolify_lab",
  }),
  providerConnections: Object.freeze({
    acme: "pconn_acme",
    beta: "pconn_beta",
    legacy: "pconn_legacy",
  }),
  servers: Object.freeze({
    acmeProd: "srv_acme_prod",
    betaProd: "srv_beta_prod",
    legacyProd: "srv_legacy_prod",
  }),
  applications: Object.freeze({
    acmeStorefront: "app_acme_storefront",
    acmeApi: "app_acme_api",
    betaPortal: "app_beta_portal",
    legacySite: "app_legacy_site",
  }),
  databases: Object.freeze({
    acmePostgres: "db_acme_postgres",
    acmeRedis: "db_acme_redis",
  }),
  deployments: Object.freeze({
    acmeStorefrontInitial: "dep_acme_storefront_01",
    acmeApiInitial: "dep_acme_api_01",
    betaPortalInitial: "dep_beta_portal_01",
  }),
  domains: Object.freeze({
    acmeStore: "dom_acme_store",
    acmeApi: "dom_acme_api",
    betaPortal: "dom_beta_portal",
  }),
  certificates: Object.freeze({
    acmeStore: "cert_acme_store",
    acmeApi: "cert_acme_api",
    betaPortal: "cert_beta_portal",
  }),
  quotas: Object.freeze({
    acme: "qta_acme",
    beta: "qta_beta",
    legacy: "qta_legacy",
  }),
  auditEvents: Object.freeze({
    acmeBootstrap: "aud_seed_acme_bootstrap",
    providerHealthCheck: "aud_seed_provider_health",
  }),
});

export interface SeedDemoDatasetOptions {
  readonly coolifyBaseUrl?: string;
  readonly oidcIssuer?: string;
  readonly now?: Date;
}

function classifyPermissionRisk(permission: PermissionKey): PermissionRiskLevel {
  if (
    permission === "platform.admin" ||
    permission === "support.impersonation.request" ||
    permission === "support.impersonation.approve" ||
    permission === "database.backup.restore"
  ) {
    return "critical";
  }

  if (
    permission.endsWith(".delete") ||
    permission.endsWith(".decommission") ||
    permission === "secrets.write" ||
    permission === "database.credentials.rotate" ||
    permission === "organization.roles.manage" ||
    permission === "organization.members.manage"
  ) {
    return "high";
  }

  if (isMutatingPermission(permission)) {
    return "medium";
  }

  return "low";
}

export async function seedDemoDataset(
  db: HostingPanelDatabase,
  options?: SeedDemoDatasetOptions,
): Promise<void> {
  const baseNow = options?.now ?? new Date("2026-11-07T09:00:00.000Z");
  const coolifyBaseUrl = options?.coolifyBaseUrl ?? DEFAULT_DEMO_COOLIFY_BASE_URL;
  const oidcIssuer = options?.oidcIssuer ?? DEFAULT_DEMO_OIDC_ISSUER;

  const oneDayMs = 24 * 60 * 60 * 1000;
  const recentDeployAt = new Date(baseNow.getTime() - 2 * 60 * 60 * 1000);
  const recentObservedAt = new Date(baseNow.getTime() - 5 * 60 * 1000);
  const lastBackupAt = new Date(baseNow.getTime() - 6 * 60 * 60 * 1000);
  const validFromDate = new Date(baseNow.getTime() - 15 * oneDayMs);
  const validCertExpiry = new Date(baseNow.getTime() + 75 * oneDayMs);
  const expiringSoonCertExpiry = new Date(baseNow.getTime() + 7 * oneDayMs);

  await db.transaction(async (tx) => {
    await tx
      .insert(permissions)
      .values(
        PERMISSION_KEYS.map((key) => ({
          key,
          description: `Permesso di controllo per ${key}`,
          riskLevel: classifyPermissionRisk(key),
        })),
      )
      .onConflictDoUpdate({
        target: permissions.key,
        set: {
          description: sql`excluded.description`,
          riskLevel: sql`excluded.risk_level`,
        },
      });

    await tx
      .insert(roles)
      .values(
        PRESET_ROLE_NAMES.map((roleName) => ({
          id: DEMO_IDS.roles[roleName],
          organizationId: null,
          name: roleName,
          isSystem: true,
          version: 1,
        })),
      )
      .onConflictDoUpdate({
        target: roles.id,
        set: {
          name: sql`excluded.name`,
          isSystem: sql`excluded.is_system`,
          version: sql`excluded.version`,
        },
      });

    const rolePermissionRows = PRESET_ROLE_NAMES.flatMap((roleName) =>
      PRESET_ROLE_PERMISSIONS[roleName].map((permissionKey) => ({
        roleId: DEMO_IDS.roles[roleName],
        permissionKey,
        effect: "allow" as const,
      })),
    );

    await tx
      .insert(rolePermissions)
      .values(rolePermissionRows)
      .onConflictDoUpdate({
        target: [rolePermissions.roleId, rolePermissions.permissionKey],
        set: {
          effect: sql`excluded.effect`,
        },
      });

    await tx
      .insert(organizations)
      .values([
        {
          id: DEMO_IDS.organizations.acme,
          slug: "acme-cloud",
          name: "Acme Cloud S.r.l.",
          type: "customer",
          status: "active",
          primaryLocale: "it-IT",
          parentResellerId: null,
          createdAt: baseNow,
          updatedAt: baseNow,
        },
        {
          id: DEMO_IDS.organizations.beta,
          slug: "beta-studios",
          name: "Beta Studios S.r.l.",
          type: "customer",
          status: "active",
          primaryLocale: "it-IT",
          parentResellerId: null,
          createdAt: baseNow,
          updatedAt: baseNow,
        },
        {
          id: DEMO_IDS.organizations.legacy,
          slug: "legacy-corp",
          name: "Legacy Corp S.p.A.",
          type: "customer",
          status: "suspended",
          primaryLocale: "it-IT",
          parentResellerId: null,
          createdAt: baseNow,
          updatedAt: baseNow,
        },
      ])
      .onConflictDoUpdate({
        target: organizations.id,
        set: {
          slug: sql`excluded.slug`,
          name: sql`excluded.name`,
          type: sql`excluded.type`,
          status: sql`excluded.status`,
          primaryLocale: sql`excluded.primary_locale`,
          updatedAt: sql`excluded.updated_at`,
        },
      });

    await tx
      .insert(users)
      .values([
        {
          id: DEMO_IDS.users.elena,
          issuer: oidcIssuer,
          subject: DEMO_IDS.users.elena,
          email: "elena.rossi@acme.it",
          emailVerified: true,
          displayName: "Elena Rossi",
          status: "active",
          isPlatformAdmin: false,
          createdAt: baseNow,
        },
        {
          id: DEMO_IDS.users.marco,
          issuer: oidcIssuer,
          subject: DEMO_IDS.users.marco,
          email: "marco.bianchi@acme.it",
          emailVerified: true,
          displayName: "Marco Bianchi",
          status: "active",
          isPlatformAdmin: false,
          createdAt: baseNow,
        },
        {
          id: DEMO_IDS.users.giulia,
          issuer: oidcIssuer,
          subject: DEMO_IDS.users.giulia,
          email: "giulia.verdi@acme.it",
          emailVerified: true,
          displayName: "Giulia Verdi",
          status: "active",
          isPlatformAdmin: false,
          createdAt: baseNow,
        },
        {
          id: DEMO_IDS.users.luca,
          issuer: oidcIssuer,
          subject: DEMO_IDS.users.luca,
          email: "luca.neri@betastudios.it",
          emailVerified: true,
          displayName: "Luca Neri",
          status: "active",
          isPlatformAdmin: false,
          createdAt: baseNow,
        },
        {
          id: DEMO_IDS.users.admin,
          issuer: oidcIssuer,
          subject: DEMO_IDS.users.admin,
          email: "admin@hosting-panel.it",
          emailVerified: true,
          displayName: "Amministratore Piattaforma",
          status: "active",
          isPlatformAdmin: true,
          createdAt: baseNow,
        },
      ])
      .onConflictDoUpdate({
        target: users.id,
        set: {
          issuer: sql`excluded.issuer`,
          subject: sql`excluded.subject`,
          email: sql`excluded.email`,
          displayName: sql`excluded.display_name`,
          status: sql`excluded.status`,
          isPlatformAdmin: sql`excluded.is_platform_admin`,
        },
      });

    await tx
      .insert(memberships)
      .values([
        {
          id: DEMO_IDS.memberships.elenaAcme,
          organizationId: DEMO_IDS.organizations.acme,
          userId: DEMO_IDS.users.elena,
          status: "active",
          createdAt: baseNow,
        },
        {
          id: DEMO_IDS.memberships.elenaBeta,
          organizationId: DEMO_IDS.organizations.beta,
          userId: DEMO_IDS.users.elena,
          status: "active",
          createdAt: baseNow,
        },
        {
          id: DEMO_IDS.memberships.elenaLegacy,
          organizationId: DEMO_IDS.organizations.legacy,
          userId: DEMO_IDS.users.elena,
          status: "active",
          createdAt: baseNow,
        },
        {
          id: DEMO_IDS.memberships.marcoAcme,
          organizationId: DEMO_IDS.organizations.acme,
          userId: DEMO_IDS.users.marco,
          status: "active",
          createdAt: baseNow,
        },
        {
          id: DEMO_IDS.memberships.giuliaAcme,
          organizationId: DEMO_IDS.organizations.acme,
          userId: DEMO_IDS.users.giulia,
          status: "active",
          createdAt: baseNow,
        },
        {
          id: DEMO_IDS.memberships.lucaBeta,
          organizationId: DEMO_IDS.organizations.beta,
          userId: DEMO_IDS.users.luca,
          status: "active",
          createdAt: baseNow,
        },
      ])
      .onConflictDoUpdate({
        target: memberships.id,
        set: {
          status: sql`excluded.status`,
        },
      });

    await tx
      .insert(membershipRoles)
      .values([
        {
          id: DEMO_IDS.membershipRoles.elenaAcmeOwner,
          membershipId: DEMO_IDS.memberships.elenaAcme,
          roleId: DEMO_IDS.roles.customer_owner,
          scopeType: "organization",
          scopeResourceId: null,
        },
        {
          id: DEMO_IDS.membershipRoles.elenaBetaViewer,
          membershipId: DEMO_IDS.memberships.elenaBeta,
          roleId: DEMO_IDS.roles.viewer,
          scopeType: "organization",
          scopeResourceId: null,
        },
        {
          id: DEMO_IDS.membershipRoles.elenaLegacyOwner,
          membershipId: DEMO_IDS.memberships.elenaLegacy,
          roleId: DEMO_IDS.roles.customer_owner,
          scopeType: "organization",
          scopeResourceId: null,
        },
        {
          id: DEMO_IDS.membershipRoles.marcoAcmeStorefrontDev,
          membershipId: DEMO_IDS.memberships.marcoAcme,
          roleId: DEMO_IDS.roles.developer,
          scopeType: "resource",
          scopeResourceId: DEMO_IDS.applications.acmeStorefront,
        },
        {
          id: DEMO_IDS.membershipRoles.giuliaAcmeViewer,
          membershipId: DEMO_IDS.memberships.giuliaAcme,
          roleId: DEMO_IDS.roles.viewer,
          scopeType: "organization",
          scopeResourceId: null,
        },
        {
          id: DEMO_IDS.membershipRoles.lucaBetaOwner,
          membershipId: DEMO_IDS.memberships.lucaBeta,
          roleId: DEMO_IDS.roles.customer_owner,
          scopeType: "organization",
          scopeResourceId: null,
        },
      ])
      .onConflictDoUpdate({
        target: membershipRoles.id,
        set: {
          roleId: sql`excluded.role_id`,
          scopeType: sql`excluded.scope_type`,
          scopeResourceId: sql`excluded.scope_resource_id`,
        },
      });

    await tx
      .insert(providerInstances)
      .values([
        {
          id: DEMO_IDS.providers.coolifyLab,
          displayName: "Coolify Lab Principale",
          kind: "coolify-v4",
          baseUrl: coolifyBaseUrl,
          status: "connected",
          version: "4.0.0-beta.380",
          capabilitiesJson: DEFAULT_COOLIFY_V4_CAPABILITIES,
          lastCheckedAt: recentObservedAt,
          createdAt: baseNow,
        },
      ])
      .onConflictDoUpdate({
        target: providerInstances.id,
        set: {
          displayName: sql`excluded.display_name`,
          baseUrl: sql`excluded.base_url`,
          status: sql`excluded.status`,
          version: sql`excluded.version`,
          capabilitiesJson: sql`excluded.capabilities_json`,
          lastCheckedAt: sql`excluded.last_checked_at`,
        },
      });

    await tx
      .insert(providerConnections)
      .values([
        {
          id: DEMO_IDS.providerConnections.acme,
          organizationId: DEMO_IDS.organizations.acme,
          providerInstanceId: DEMO_IDS.providers.coolifyLab,
          teamId: "team_acme",
          secretRefRead: "vault://coolify/acme/read",
          secretRefWrite: "vault://coolify/acme/write",
          secretRefDeploy: "vault://coolify/acme/deploy",
          status: "connected",
          createdAt: baseNow,
        },
        {
          id: DEMO_IDS.providerConnections.beta,
          organizationId: DEMO_IDS.organizations.beta,
          providerInstanceId: DEMO_IDS.providers.coolifyLab,
          teamId: "team_beta",
          secretRefRead: "vault://coolify/beta/read",
          secretRefWrite: "vault://coolify/beta/write",
          secretRefDeploy: "vault://coolify/beta/deploy",
          status: "connected",
          createdAt: baseNow,
        },
        {
          id: DEMO_IDS.providerConnections.legacy,
          organizationId: DEMO_IDS.organizations.legacy,
          providerInstanceId: DEMO_IDS.providers.coolifyLab,
          teamId: "team_legacy",
          secretRefRead: "vault://coolify/legacy/read",
          secretRefWrite: null,
          secretRefDeploy: "vault://coolify/legacy/deploy",
          status: "degraded",
          createdAt: baseNow,
        },
      ])
      .onConflictDoUpdate({
        target: providerConnections.id,
        set: {
          secretRefRead: sql`excluded.secret_ref_read`,
          secretRefWrite: sql`excluded.secret_ref_write`,
          secretRefDeploy: sql`excluded.secret_ref_deploy`,
          status: sql`excluded.status`,
        },
      });

    await tx
      .insert(serverAllocations)
      .values([
        {
          id: DEMO_IDS.servers.acmeProd,
          organizationId: DEMO_IDS.organizations.acme,
          providerConnectionId: DEMO_IDS.providerConnections.acme,
          providerServerId: "coolify-srv-acme-01",
          name: "milano-prod-01",
          region: "eu-south-1",
          publicIpv4: "198.51.100.10",
          status: "running",
          health: "healthy",
          vcpuCount: 8,
          memoryMb: 16384,
          diskGb: 160,
          lastObservedAt: recentObservedAt,
          createdAt: baseNow,
        },
        {
          id: DEMO_IDS.servers.betaProd,
          organizationId: DEMO_IDS.organizations.beta,
          providerConnectionId: DEMO_IDS.providerConnections.beta,
          providerServerId: "coolify-srv-beta-01",
          name: "torino-prod-01",
          region: "eu-south-1",
          publicIpv4: "198.51.100.20",
          status: "running",
          health: "healthy",
          vcpuCount: 4,
          memoryMb: 8192,
          diskGb: 80,
          lastObservedAt: recentObservedAt,
          createdAt: baseNow,
        },
        {
          id: DEMO_IDS.servers.legacyProd,
          organizationId: DEMO_IDS.organizations.legacy,
          providerConnectionId: DEMO_IDS.providerConnections.legacy,
          providerServerId: "coolify-srv-legacy-01",
          name: "roma-legacy-01",
          region: "eu-south-1",
          publicIpv4: "198.51.100.30",
          status: "stopped",
          health: "unknown",
          vcpuCount: 2,
          memoryMb: 4096,
          diskGb: 40,
          lastObservedAt: recentObservedAt,
          createdAt: baseNow,
        },
      ])
      .onConflictDoUpdate({
        target: serverAllocations.id,
        set: {
          name: sql`excluded.name`,
          status: sql`excluded.status`,
          health: sql`excluded.health`,
          lastObservedAt: sql`excluded.last_observed_at`,
        },
      });

    await tx
      .insert(hostingResources)
      .values([
        {
          id: DEMO_IDS.applications.acmeStorefront,
          organizationId: DEMO_IDS.organizations.acme,
          connectionId: DEMO_IDS.providerConnections.acme,
          serverAllocationId: DEMO_IDS.servers.acmeProd,
          type: "application",
          name: "Acme Storefront",
          slug: "acme-storefront",
          providerId: "coolify-app-acme-storefront",
          desiredState: "running",
          observedStatus: "running",
          health: "healthy",
          observedSource: "coolify",
          lastObservedAt: recentObservedAt,
          lockedByOperationId: null,
          version: 1,
          createdAt: baseNow,
          updatedAt: baseNow,
        },
        {
          id: DEMO_IDS.applications.acmeApi,
          organizationId: DEMO_IDS.organizations.acme,
          connectionId: DEMO_IDS.providerConnections.acme,
          serverAllocationId: DEMO_IDS.servers.acmeProd,
          type: "application",
          name: "Acme Core API",
          slug: "acme-core-api",
          providerId: "coolify-app-acme-api",
          desiredState: "running",
          observedStatus: "running",
          health: "healthy",
          observedSource: "coolify",
          lastObservedAt: recentObservedAt,
          lockedByOperationId: null,
          version: 1,
          createdAt: baseNow,
          updatedAt: baseNow,
        },
        {
          id: DEMO_IDS.applications.betaPortal,
          organizationId: DEMO_IDS.organizations.beta,
          connectionId: DEMO_IDS.providerConnections.beta,
          serverAllocationId: DEMO_IDS.servers.betaProd,
          type: "application",
          name: "Beta Client Portal",
          slug: "beta-client-portal",
          providerId: "coolify-app-beta-portal",
          desiredState: "running",
          observedStatus: "running",
          health: "healthy",
          observedSource: "coolify",
          lastObservedAt: recentObservedAt,
          lockedByOperationId: null,
          version: 1,
          createdAt: baseNow,
          updatedAt: baseNow,
        },
        {
          id: DEMO_IDS.applications.legacySite,
          organizationId: DEMO_IDS.organizations.legacy,
          connectionId: DEMO_IDS.providerConnections.legacy,
          serverAllocationId: DEMO_IDS.servers.legacyProd,
          type: "application",
          name: "Legacy Corporate Site",
          slug: "legacy-corporate-site",
          providerId: "coolify-app-legacy-site",
          desiredState: "stopped",
          observedStatus: "stopped",
          health: "unknown",
          observedSource: "coolify",
          lastObservedAt: recentObservedAt,
          lockedByOperationId: null,
          version: 1,
          createdAt: baseNow,
          updatedAt: baseNow,
        },
        {
          id: DEMO_IDS.databases.acmePostgres,
          organizationId: DEMO_IDS.organizations.acme,
          connectionId: DEMO_IDS.providerConnections.acme,
          serverAllocationId: DEMO_IDS.servers.acmeProd,
          type: "database",
          name: "Acme Primary PostgreSQL",
          slug: "acme-primary-postgres",
          providerId: "coolify-db-acme-pg",
          desiredState: "running",
          observedStatus: "running",
          health: "healthy",
          observedSource: "coolify",
          lastObservedAt: recentObservedAt,
          lockedByOperationId: null,
          version: 1,
          createdAt: baseNow,
          updatedAt: baseNow,
        },
        {
          id: DEMO_IDS.databases.acmeRedis,
          organizationId: DEMO_IDS.organizations.acme,
          connectionId: DEMO_IDS.providerConnections.acme,
          serverAllocationId: DEMO_IDS.servers.acmeProd,
          type: "database",
          name: "Acme Session Redis",
          slug: "acme-session-redis",
          providerId: "coolify-db-acme-redis",
          desiredState: "running",
          observedStatus: "running",
          health: "healthy",
          observedSource: "coolify",
          lastObservedAt: recentObservedAt,
          lockedByOperationId: null,
          version: 1,
          createdAt: baseNow,
          updatedAt: baseNow,
        },
      ])
      .onConflictDoUpdate({
        target: hostingResources.id,
        set: {
          name: sql`excluded.name`,
          slug: sql`excluded.slug`,
          desiredState: sql`excluded.desired_state`,
          observedStatus: sql`excluded.observed_status`,
          health: sql`excluded.health`,
          lastObservedAt: sql`excluded.last_observed_at`,
          updatedAt: sql`excluded.updated_at`,
        },
      });

    await tx
      .insert(applications)
      .values([
        {
          resourceId: DEMO_IDS.applications.acmeStorefront,
          environment: "production",
          repositoryUrl: "https://git.acme.it/acme/storefront",
          branch: "main",
          buildPack: "nixpacks",
          primaryDomain: "store.acme.it",
          lastDeployedAt: recentDeployAt,
        },
        {
          resourceId: DEMO_IDS.applications.acmeApi,
          environment: "production",
          repositoryUrl: "https://git.acme.it/acme/core-api",
          branch: "main",
          buildPack: "dockerfile",
          primaryDomain: "api.acme.it",
          lastDeployedAt: recentDeployAt,
        },
        {
          resourceId: DEMO_IDS.applications.betaPortal,
          environment: "production",
          repositoryUrl: "https://git.betastudios.it/beta/portal",
          branch: "main",
          buildPack: "nixpacks",
          primaryDomain: "portal.betastudios.it",
          lastDeployedAt: recentDeployAt,
        },
        {
          resourceId: DEMO_IDS.applications.legacySite,
          environment: "production",
          repositoryUrl: "https://git.legacycorp.it/web/site",
          branch: "master",
          buildPack: "static",
          primaryDomain: "www.legacycorp.it",
          lastDeployedAt: null,
        },
      ])
      .onConflictDoUpdate({
        target: applications.resourceId,
        set: {
          environment: sql`excluded.environment`,
          repositoryUrl: sql`excluded.repository_url`,
          branch: sql`excluded.branch`,
          buildPack: sql`excluded.build_pack`,
          primaryDomain: sql`excluded.primary_domain`,
          lastDeployedAt: sql`excluded.last_deployed_at`,
        },
      });

    await tx
      .insert(databases)
      .values([
        {
          resourceId: DEMO_IDS.databases.acmePostgres,
          engine: "postgresql",
          engineVersion: "18.1",
          storageAllocatedGb: 50,
          internalHostname: "acme-postgres.internal",
          port: 5432,
          lastBackupAt,
        },
        {
          resourceId: DEMO_IDS.databases.acmeRedis,
          engine: "redis",
          engineVersion: "7.4",
          storageAllocatedGb: 10,
          internalHostname: "acme-redis.internal",
          port: 6379,
          lastBackupAt: null,
        },
      ])
      .onConflictDoUpdate({
        target: databases.resourceId,
        set: {
          engine: sql`excluded.engine`,
          engineVersion: sql`excluded.engine_version`,
          storageAllocatedGb: sql`excluded.storage_allocated_gb`,
          internalHostname: sql`excluded.internal_hostname`,
          port: sql`excluded.port`,
          lastBackupAt: sql`excluded.last_backup_at`,
        },
      });

    await tx
      .insert(resourceGrants)
      .values([
        {
          id: DEMO_IDS.resourceGrants.marcoStorefrontRead,
          organizationId: DEMO_IDS.organizations.acme,
          principalUserId: DEMO_IDS.users.marco,
          resourceId: DEMO_IDS.applications.acmeStorefront,
          permission: "application.read",
          effect: "allow",
          expiresAt: null,
          createdAt: baseNow,
        },
        {
          id: DEMO_IDS.resourceGrants.marcoStorefrontDeploy,
          organizationId: DEMO_IDS.organizations.acme,
          principalUserId: DEMO_IDS.users.marco,
          resourceId: DEMO_IDS.applications.acmeStorefront,
          permission: "application.deploy",
          effect: "allow",
          expiresAt: null,
          createdAt: baseNow,
        },
        {
          id: DEMO_IDS.resourceGrants.marcoStorefrontRestart,
          organizationId: DEMO_IDS.organizations.acme,
          principalUserId: DEMO_IDS.users.marco,
          resourceId: DEMO_IDS.applications.acmeStorefront,
          permission: "application.restart",
          effect: "allow",
          expiresAt: null,
          createdAt: baseNow,
        },
        {
          id: DEMO_IDS.resourceGrants.marcoStorefrontLogs,
          organizationId: DEMO_IDS.organizations.acme,
          principalUserId: DEMO_IDS.users.marco,
          resourceId: DEMO_IDS.applications.acmeStorefront,
          permission: "application.logs.read",
          effect: "allow",
          expiresAt: null,
          createdAt: baseNow,
        },
      ])
      .onConflictDoUpdate({
        target: resourceGrants.id,
        set: {
          permission: sql`excluded.permission`,
          effect: sql`excluded.effect`,
          expiresAt: sql`excluded.expires_at`,
        },
      });

    await tx
      .insert(deploymentRecords)
      .values([
        {
          id: DEMO_IDS.deployments.acmeStorefrontInitial,
          applicationResourceId: DEMO_IDS.applications.acmeStorefront,
          organizationId: DEMO_IDS.organizations.acme,
          operationId: null,
          providerDeploymentId: "coolify-dep-storefront-01",
          commitSha: "a1b2c3d4e5f6",
          imageTag: "v2.4.1",
          status: "succeeded",
          triggeredByUserId: DEMO_IDS.users.elena,
          startedAt: new Date(recentDeployAt.getTime() - 90_000),
          finishedAt: recentDeployAt,
          createdAt: recentDeployAt,
        },
        {
          id: DEMO_IDS.deployments.acmeApiInitial,
          applicationResourceId: DEMO_IDS.applications.acmeApi,
          organizationId: DEMO_IDS.organizations.acme,
          operationId: null,
          providerDeploymentId: "coolify-dep-api-01",
          commitSha: "f6e5d4c3b2a1",
          imageTag: "v1.12.0",
          status: "succeeded",
          triggeredByUserId: DEMO_IDS.users.elena,
          startedAt: new Date(recentDeployAt.getTime() - 60_000),
          finishedAt: recentDeployAt,
          createdAt: recentDeployAt,
        },
        {
          id: DEMO_IDS.deployments.betaPortalInitial,
          applicationResourceId: DEMO_IDS.applications.betaPortal,
          organizationId: DEMO_IDS.organizations.beta,
          operationId: null,
          providerDeploymentId: "coolify-dep-beta-01",
          commitSha: "9876543210ab",
          imageTag: "v1.0.3",
          status: "succeeded",
          triggeredByUserId: DEMO_IDS.users.luca,
          startedAt: new Date(recentDeployAt.getTime() - 75_000),
          finishedAt: recentDeployAt,
          createdAt: recentDeployAt,
        },
      ])
      .onConflictDoNothing({ target: deploymentRecords.id });

    await tx
      .insert(domains)
      .values([
        {
          id: DEMO_IDS.domains.acmeStore,
          organizationId: DEMO_IDS.organizations.acme,
          applicationResourceId: DEMO_IDS.applications.acmeStorefront,
          hostname: "store.acme.it",
          isPrimary: true,
          verificationStatus: "verified",
          httpsEnabled: true,
          createdAt: baseNow,
          updatedAt: baseNow,
        },
        {
          id: DEMO_IDS.domains.acmeApi,
          organizationId: DEMO_IDS.organizations.acme,
          applicationResourceId: DEMO_IDS.applications.acmeApi,
          hostname: "api.acme.it",
          isPrimary: true,
          verificationStatus: "verified",
          httpsEnabled: true,
          createdAt: baseNow,
          updatedAt: baseNow,
        },
        {
          id: DEMO_IDS.domains.betaPortal,
          organizationId: DEMO_IDS.organizations.beta,
          applicationResourceId: DEMO_IDS.applications.betaPortal,
          hostname: "portal.betastudios.it",
          isPrimary: true,
          verificationStatus: "verified",
          httpsEnabled: true,
          createdAt: baseNow,
          updatedAt: baseNow,
        },
      ])
      .onConflictDoUpdate({
        target: domains.id,
        set: {
          hostname: sql`excluded.hostname`,
          isPrimary: sql`excluded.is_primary`,
          verificationStatus: sql`excluded.verification_status`,
          httpsEnabled: sql`excluded.https_enabled`,
          updatedAt: sql`excluded.updated_at`,
        },
      });

    await tx
      .insert(certificateObservations)
      .values([
        {
          id: DEMO_IDS.certificates.acmeStore,
          domainId: DEMO_IDS.domains.acmeStore,
          organizationId: DEMO_IDS.organizations.acme,
          hostname: "store.acme.it",
          status: "valid",
          issuer: "Let's Encrypt R11",
          validFrom: validFromDate,
          expiresAt: validCertExpiry,
          observedAt: recentObservedAt,
          source: "coolify",
        },
        {
          id: DEMO_IDS.certificates.acmeApi,
          domainId: DEMO_IDS.domains.acmeApi,
          organizationId: DEMO_IDS.organizations.acme,
          hostname: "api.acme.it",
          status: "expiring_soon",
          issuer: "Let's Encrypt R11",
          validFrom: validFromDate,
          expiresAt: expiringSoonCertExpiry,
          observedAt: recentObservedAt,
          source: "coolify",
        },
        {
          id: DEMO_IDS.certificates.betaPortal,
          domainId: DEMO_IDS.domains.betaPortal,
          organizationId: DEMO_IDS.organizations.beta,
          hostname: "portal.betastudios.it",
          status: "valid",
          issuer: "Let's Encrypt E6",
          validFrom: validFromDate,
          expiresAt: validCertExpiry,
          observedAt: recentObservedAt,
          source: "coolify",
        },
      ])
      .onConflictDoUpdate({
        target: certificateObservations.id,
        set: {
          status: sql`excluded.status`,
          issuer: sql`excluded.issuer`,
          validFrom: sql`excluded.valid_from`,
          expiresAt: sql`excluded.expires_at`,
          observedAt: sql`excluded.observed_at`,
          source: sql`excluded.source`,
        },
      });

    await tx
      .insert(quotaAllocations)
      .values([
        {
          id: DEMO_IDS.quotas.acme,
          organizationId: DEMO_IDS.organizations.acme,
          planCode: "business-it",
          serversUsed: 1,
          serversLimit: 5,
          applicationsUsed: 2,
          applicationsLimit: 10,
          databasesUsed: 2,
          databasesLimit: 6,
          domainsUsed: 2,
          domainsLimit: 20,
          updatedAt: baseNow,
        },
        {
          id: DEMO_IDS.quotas.beta,
          organizationId: DEMO_IDS.organizations.beta,
          planCode: "starter-it",
          serversUsed: 1,
          serversLimit: 2,
          applicationsUsed: 1,
          applicationsLimit: 4,
          databasesUsed: 0,
          databasesLimit: 2,
          domainsUsed: 1,
          domainsLimit: 5,
          updatedAt: baseNow,
        },
        {
          id: DEMO_IDS.quotas.legacy,
          organizationId: DEMO_IDS.organizations.legacy,
          planCode: "starter-it",
          serversUsed: 1,
          serversLimit: 1,
          applicationsUsed: 1,
          applicationsLimit: 2,
          databasesUsed: 0,
          databasesLimit: 1,
          domainsUsed: 0,
          domainsLimit: 2,
          updatedAt: baseNow,
        },
      ])
      .onConflictDoUpdate({
        target: quotaAllocations.id,
        set: {
          planCode: sql`excluded.plan_code`,
          serversUsed: sql`excluded.servers_used`,
          serversLimit: sql`excluded.servers_limit`,
          applicationsUsed: sql`excluded.applications_used`,
          applicationsLimit: sql`excluded.applications_limit`,
          databasesUsed: sql`excluded.databases_used`,
          databasesLimit: sql`excluded.databases_limit`,
          domainsUsed: sql`excluded.domains_used`,
          domainsLimit: sql`excluded.domains_limit`,
          updatedAt: sql`excluded.updated_at`,
        },
      });

    const acmeAuditMeta = AuditMetadataSchema.parse({
      environment: "poc-lab",
      seeded: true,
    });
    const providerAuditMeta = AuditMetadataSchema.parse({
      driver: "coolify-v4",
      status: "connected",
    });

    await tx
      .insert(auditEvents)
      .values([
        {
          id: DEMO_IDS.auditEvents.acmeBootstrap,
          organizationId: DEMO_IDS.organizations.acme,
          actorUserId: DEMO_IDS.users.elena,
          actorEmail: "elena.rossi@acme.it",
          impersonatedByUserId: null,
          action: "organization.bootstrap",
          targetType: "organization",
          targetId: DEMO_IDS.organizations.acme,
          outcome: "succeeded",
          requestId: "req_seed_acme_bootstrap",
          ipAddress: "127.0.0.1",
          metadataJson: acmeAuditMeta,
          occurredAt: baseNow,
        },
        {
          id: DEMO_IDS.auditEvents.providerHealthCheck,
          organizationId: null,
          actorUserId: DEMO_IDS.users.admin,
          actorEmail: "admin@hosting-panel.it",
          impersonatedByUserId: null,
          action: "provider.connection.test",
          targetType: "provider",
          targetId: DEMO_IDS.providers.coolifyLab,
          outcome: "succeeded",
          requestId: "req_seed_provider_health",
          ipAddress: "127.0.0.1",
          metadataJson: providerAuditMeta,
          occurredAt: recentObservedAt,
        },
      ])
      .onConflictDoNothing({ target: auditEvents.id });
  });
}
