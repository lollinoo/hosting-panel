import {
  PERMISSION_KEYS,
  PRESET_ROLE_NAMES,
  PRESET_ROLE_PERMISSIONS,
} from "@hosting-panel/contracts";
import { buildImmutableStackRevision } from "@hosting-panel/hosting-domain";
import type { HostingPanelDatabase } from "./client.js";
import {
  auditEvents,
  dockerResources,
  domains,
  hostAllocations,
  hostingAdminScopes,
  hosts,
  membershipRoles,
  memberships,
  observedStates,
  organizations,
  permissions,
  platformInstallations,
  resourceGrants,
  resourceQuotas,
  rolePermissions,
  roles,
  serviceInstances,
  serviceTemplates,
  sites,
  stackRevisions,
  users,
} from "./schema.js";

export const DEMO_IDS = Object.freeze({
  installation: "inst_local_01",
  hosts: Object.freeze({
    acme: "hst_ded_acme",
    beta: "hst_ded_beta",
    gamma: "hst_ded_gamma",
    free: "hst_ded_free",
    maint: "hst_maint_01",
  }),
  organizations: Object.freeze({
    acme: "org_acme",
    beta: "org_beta",
    gamma: "org_gamma",
  }),
  users: Object.freeze({
    infra: "usr_infra",
    hosting: "usr_hosting",
    elena: "usr_elena",
    marco: "usr_marco",
    giulia: "usr_giulia",
  }),
  roles: Object.freeze({
    infrastructure_admin: "role_infrastructure_admin",
    hosting_admin: "role_hosting_admin",
    customer_owner: "role_customer_owner",
    customer_collaborator: "role_customer_collaborator",
  }),
  templates: Object.freeze({
    wordpress: "tpl_wordpress_83",
    nodejs: "tpl_nodejs_24",
    mariadb: "tpl_mariadb_11",
    redis: "tpl_redis_7",
  }),
  allocations: Object.freeze({
    acme: "alloc_ded_acme",
    beta: "alloc_ded_beta",
    gamma: "alloc_ded_gamma",
  }),
  sites: Object.freeze({
    acmeShop: "site_acme_shop",
    acmeBlog: "site_acme_blog",
    betaPortal: "site_beta_portal",
    gammaLegacy: "site_gamma_legacy",
  }),
  services: Object.freeze({
    acmeShopWp: "svc_acme_shop_wp",
    acmeShopDb: "svc_acme_shop_db",
    acmeShopRedis: "svc_acme_shop_redis",
    acmeBlogWp: "svc_acme_blog_wp",
    acmeBlogDb: "svc_acme_blog_db",
    betaPortalNode: "svc_beta_portal_node",
    gammaLegacyApp: "svc_gamma_legacy_app",
  }),
});

export async function seedPhase1Dataset(db: HostingPanelDatabase): Promise<void> {
  const now = new Date();

  // 1. Platform Installation
  await db
    .insert(platformInstallations)
    .values({
      id: DEMO_IDS.installation,
      name: "Hosting Control Panel Local Appliance",
      specVersion: "HCP-SPEC-002",
      phase: "phase-1",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  // 2. Roles & Permissions
  for (const roleName of PRESET_ROLE_NAMES) {
    await db
      .insert(roles)
      .values({
        id: DEMO_IDS.roles[roleName],
        name: roleName,
        description: `Preset role: ${roleName}`,
        isPreset: true,
      })
      .onConflictDoNothing();
  }

  for (const permKey of PERMISSION_KEYS) {
    await db
      .insert(permissions)
      .values({
        key: permKey,
        description: `Permission key: ${permKey}`,
      })
      .onConflictDoNothing();
  }

  for (const roleName of PRESET_ROLE_NAMES) {
    const roleId = DEMO_IDS.roles[roleName];
    const perms = PRESET_ROLE_PERMISSIONS[roleName];
    for (const permKey of perms) {
      await db
        .insert(rolePermissions)
        .values({
          roleId,
          permissionKey: permKey,
        })
        .onConflictDoNothing();
    }
  }

  // 3. Demo Users
  await db
    .insert(users)
    .values([
      {
        id: DEMO_IDS.users.infra,
        email: "infra@hcp.local",
        name: "Admin Infrastruttura",
        userStatus: "active",
      },
      {
        id: DEMO_IDS.users.hosting,
        email: "hosting@hcp.local",
        name: "Admin Hosting",
        userStatus: "active",
      },
      {
        id: DEMO_IDS.users.elena,
        email: "elena@acme.it",
        name: "Elena Rossi (Acme Owner)",
        userStatus: "active",
      },
      {
        id: DEMO_IDS.users.marco,
        email: "marco@acme.it",
        name: "Marco Bianchi (Acme Dev)",
        userStatus: "active",
      },
      {
        id: DEMO_IDS.users.giulia,
        email: "giulia@gamma.it",
        name: "Giulia Verdi (Gamma Suspended)",
        userStatus: "active",
      },
    ])
    .onConflictDoNothing();

  // 4. Demo Organizations
  await db
    .insert(organizations)
    .values([
      {
        id: DEMO_IDS.organizations.acme,
        platformInstallationId: DEMO_IDS.installation,
        name: "Acme S.r.l.",
        slug: "acme-srl",
        status: "active",
      },
      {
        id: DEMO_IDS.organizations.beta,
        platformInstallationId: DEMO_IDS.installation,
        name: "Beta Digital S.r.l.",
        slug: "beta-digital",
        status: "active",
      },
      {
        id: DEMO_IDS.organizations.gamma,
        platformInstallationId: DEMO_IDS.installation,
        name: "Gamma Archivio S.r.l.",
        slug: "gamma-archivio",
        status: "suspended", // Commercial suspension
      },
    ])
    .onConflictDoNothing();

  // 5. Memberships & Roles
  await db
    .insert(memberships)
    .values([
      {
        id: "mem_elena_acme",
        organizationId: DEMO_IDS.organizations.acme,
        userId: DEMO_IDS.users.elena,
        status: "active",
      },
      {
        id: "mem_elena_beta",
        organizationId: DEMO_IDS.organizations.beta,
        userId: DEMO_IDS.users.elena,
        status: "active",
      },
      {
        id: "mem_marco_acme",
        organizationId: DEMO_IDS.organizations.acme,
        userId: DEMO_IDS.users.marco,
        status: "active",
      },
      {
        id: "mem_giulia_gamma",
        organizationId: DEMO_IDS.organizations.gamma,
        userId: DEMO_IDS.users.giulia,
        status: "active",
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(membershipRoles)
    .values([
      {
        id: "mr_elena_acme_owner",
        membershipId: "mem_elena_acme",
        roleId: DEMO_IDS.roles.customer_owner,
        scopeType: "organization",
      },
      {
        id: "mr_elena_beta_collab",
        membershipId: "mem_elena_beta",
        roleId: DEMO_IDS.roles.customer_collaborator,
        scopeType: "organization",
      },
      {
        id: "mr_marco_acme_collab",
        membershipId: "mem_marco_acme",
        roleId: DEMO_IDS.roles.customer_collaborator,
        scopeType: "organization",
      },
      {
        id: "mr_giulia_gamma_owner",
        membershipId: "mem_giulia_gamma",
        roleId: DEMO_IDS.roles.customer_owner,
        scopeType: "organization",
      },
    ])
    .onConflictDoNothing();

  // Hosting Admin global scope
  await db
    .insert(hostingAdminScopes)
    .values({
      id: "scope_hosting_all",
      userId: DEMO_IDS.users.hosting,
      organizationId: "*",
      installationId: DEMO_IDS.installation,
    })
    .onConflictDoNothing();

  // 6. Marco's ABAC Resource Grants on Acme
  await db
    .insert(resourceGrants)
    .values([
      {
        id: "rg_marco_shop_allow",
        organizationId: DEMO_IDS.organizations.acme,
        principalUserId: DEMO_IDS.users.marco,
        resourceId: DEMO_IDS.sites.acmeShop,
        permission: "site.read",
        effect: "allow",
        expiresAt: null,
      },
      {
        id: "rg_marco_blog_deny",
        organizationId: DEMO_IDS.organizations.acme,
        principalUserId: DEMO_IDS.users.marco,
        resourceId: DEMO_IDS.sites.acmeBlog,
        permission: "site.read",
        effect: "deny",
        expiresAt: null,
      },
    ])
    .onConflictDoNothing();

  // 7. Demo Hosts
  await db
    .insert(hosts)
    .values([
      {
        id: DEMO_IDS.hosts.acme,
        platformInstallationId: DEMO_IDS.installation,
        name: "Dedicated Node Acme",
        hostname: "node-acme.internal",
        ipv4Address: "192.168.10.11",
        status: "ready",
        hostingMode: "dedicated",
        totalCpuMilli: 8000,
        totalMemoryBytes: "17179869184", // 16GB
        totalStorageBytes: "107374182400", // 100GB
        securityReviewed: true,
        sharedApproved: false,
      },
      {
        id: DEMO_IDS.hosts.beta,
        platformInstallationId: DEMO_IDS.installation,
        name: "Dedicated Node Beta",
        hostname: "node-beta.internal",
        ipv4Address: "192.168.10.12",
        status: "ready",
        hostingMode: "dedicated",
        totalCpuMilli: 8000,
        totalMemoryBytes: "17179869184",
        totalStorageBytes: "107374182400",
        securityReviewed: true,
        sharedApproved: false,
      },
      {
        id: DEMO_IDS.hosts.gamma,
        platformInstallationId: DEMO_IDS.installation,
        name: "Dedicated Node Gamma",
        hostname: "node-gamma.internal",
        ipv4Address: "192.168.10.15",
        status: "ready",
        hostingMode: "dedicated",
        totalCpuMilli: 4000,
        totalMemoryBytes: "8589934592",
        totalStorageBytes: "53687091200",
        securityReviewed: true,
        sharedApproved: false,
      },
      {
        id: DEMO_IDS.hosts.free,
        platformInstallationId: DEMO_IDS.installation,
        name: "Free Unallocated Dedicated Node",
        hostname: "node-free.internal",
        ipv4Address: "192.168.10.13",
        status: "ready",
        hostingMode: "dedicated",
        totalCpuMilli: 8000,
        totalMemoryBytes: "17179869184",
        totalStorageBytes: "107374182400",
        securityReviewed: true,
        sharedApproved: false,
      },
      {
        id: DEMO_IDS.hosts.maint,
        platformInstallationId: DEMO_IDS.installation,
        name: "Maintenance Dedicated Node",
        hostname: "node-maint.internal",
        ipv4Address: "192.168.10.14",
        status: "maintenance",
        hostingMode: "dedicated",
        totalCpuMilli: 4000,
        totalMemoryBytes: "8589934592",
        totalStorageBytes: "53687091200",
        securityReviewed: false,
        sharedApproved: false,
      },
    ])
    .onConflictDoNothing();

  // 8. Host Allocations
  await db
    .insert(hostAllocations)
    .values([
      {
        id: DEMO_IDS.allocations.acme,
        hostId: DEMO_IDS.hosts.acme,
        organizationId: DEMO_IDS.organizations.acme,
        status: "active",
        hostingMode: "dedicated",
        dedicatedScope: true,
      },
      {
        id: DEMO_IDS.allocations.beta,
        hostId: DEMO_IDS.hosts.beta,
        organizationId: DEMO_IDS.organizations.beta,
        status: "active",
        hostingMode: "dedicated",
        dedicatedScope: true,
      },
      {
        id: DEMO_IDS.allocations.gamma,
        hostId: DEMO_IDS.hosts.gamma,
        organizationId: DEMO_IDS.organizations.gamma,
        status: "active",
        hostingMode: "dedicated",
        dedicatedScope: true,
      },
    ])
    .onConflictDoNothing();

  // 9. Resource Quotas
  await db
    .insert(resourceQuotas)
    .values([
      {
        id: "qta_acme",
        organizationId: DEMO_IDS.organizations.acme,
        hostAllocationId: DEMO_IDS.allocations.acme,
        maxSites: 10,
        maxServices: 20,
        maxCpuMilli: 8000,
        maxMemoryBytes: "17179869184",
        maxStorageBytes: "107374182400",
        usedSites: 2,
        usedServices: 5,
        usedCpuMilli: 3500,
        usedMemoryBytes: "4294967296",
        usedStorageBytes: "21474836480",
      },
      {
        id: "qta_beta",
        organizationId: DEMO_IDS.organizations.beta,
        hostAllocationId: DEMO_IDS.allocations.beta,
        maxSites: 5,
        maxServices: 10,
        maxCpuMilli: 8000,
        maxMemoryBytes: "17179869184",
        maxStorageBytes: "107374182400",
        usedSites: 1,
        usedServices: 1,
        usedCpuMilli: 1000,
        usedMemoryBytes: "1073741824",
        usedStorageBytes: "5368709120",
      },
      {
        id: "qta_gamma",
        organizationId: DEMO_IDS.organizations.gamma,
        hostAllocationId: DEMO_IDS.allocations.gamma,
        maxSites: 2,
        maxServices: 4,
        maxCpuMilli: 2000,
        maxMemoryBytes: "4294967296",
        maxStorageBytes: "21474836480",
        usedSites: 1,
        usedServices: 1,
        usedCpuMilli: 500,
        usedMemoryBytes: "536870912",
        usedStorageBytes: "1073741824",
      },
    ])
    .onConflictDoNothing();

  // 10. Service Templates
  await db
    .insert(serviceTemplates)
    .values([
      {
        id: DEMO_IDS.templates.wordpress,
        name: "WordPress 6.4 + PHP 8.3",
        slug: "wordpress-83",
        description: "Official WordPress image configured for production",
        category: "cms",
        defaultImage: "wordpress:6.4-php8.3",
        defaultPort: 80,
        environmentSchema: {},
        defaultConfiguration: { tablePrefix: "wp_" },
        approvedForDedicated: true,
        approvedForShared: false,
        minCpuMilli: 500,
        minMemoryBytes: "536870912",
      },
      {
        id: DEMO_IDS.templates.nodejs,
        name: "Node.js 24 LTS",
        slug: "nodejs-24",
        description: "Node.js 24 runtime container",
        category: "runtime",
        defaultImage: "node:24-alpine",
        defaultPort: 3000,
        environmentSchema: {},
        defaultConfiguration: { NODE_ENV: "production" },
        approvedForDedicated: true,
        approvedForShared: false,
        minCpuMilli: 250,
        minMemoryBytes: "268435456",
      },
      {
        id: DEMO_IDS.templates.mariadb,
        name: "MariaDB 11.4 LTS",
        slug: "mariadb-11",
        description: "MariaDB database engine",
        category: "database",
        defaultImage: "mariadb:11.4",
        defaultPort: 3306,
        environmentSchema: {},
        defaultConfiguration: { characterSet: "utf8mb4" },
        approvedForDedicated: true,
        approvedForShared: false,
        minCpuMilli: 500,
        minMemoryBytes: "1073741824",
      },
      {
        id: DEMO_IDS.templates.redis,
        name: "Redis 7.4",
        slug: "redis-7",
        description: "In-memory cache and message store",
        category: "cache",
        defaultImage: "redis:7.4-alpine",
        defaultPort: 6379,
        environmentSchema: {},
        defaultConfiguration: { maxmemoryPolicy: "allkeys-lru" },
        approvedForDedicated: true,
        approvedForShared: false,
        minCpuMilli: 200,
        minMemoryBytes: "268435456",
      },
    ])
    .onConflictDoNothing();

  // 11. Sites
  await db
    .insert(sites)
    .values([
      {
        id: DEMO_IDS.sites.acmeShop,
        organizationId: DEMO_IDS.organizations.acme,
        hostAllocationId: DEMO_IDS.allocations.acme,
        name: "Acme E-Commerce Shop",
        slug: "acme-shop",
        status: "ready",
      },
      {
        id: DEMO_IDS.sites.acmeBlog,
        organizationId: DEMO_IDS.organizations.acme,
        hostAllocationId: DEMO_IDS.allocations.acme,
        name: "Acme Corporate Blog",
        slug: "acme-blog",
        status: "degraded", // Contains drifted service
      },
      {
        id: DEMO_IDS.sites.betaPortal,
        organizationId: DEMO_IDS.organizations.beta,
        hostAllocationId: DEMO_IDS.allocations.beta,
        name: "Beta Digital Client Portal",
        slug: "beta-portal",
        status: "ready",
      },
      {
        id: DEMO_IDS.sites.gammaLegacy,
        organizationId: DEMO_IDS.organizations.gamma,
        hostAllocationId: DEMO_IDS.allocations.gamma,
        name: "Gamma Archivio Documentale",
        slug: "gamma-legacy",
        status: "stopped",
      },
    ])
    .onConflictDoNothing();

  // 12. Domains
  await db
    .insert(domains)
    .values([
      {
        id: "dom_acme_shop",
        siteId: DEMO_IDS.sites.acmeShop,
        organizationId: DEMO_IDS.organizations.acme,
        hostname: "negozio.acme.it",
        isPrimary: true,
        status: "active",
      },
      {
        id: "dom_acme_blog",
        siteId: DEMO_IDS.sites.acmeBlog,
        organizationId: DEMO_IDS.organizations.acme,
        hostname: "blog.acme.it",
        isPrimary: true,
        status: "active",
      },
      {
        id: "dom_beta_portal",
        siteId: DEMO_IDS.sites.betaPortal,
        organizationId: DEMO_IDS.organizations.beta,
        hostname: "portale.betadigital.it",
        isPrimary: true,
        status: "active",
      },
      {
        id: "dom_gamma_legacy",
        siteId: DEMO_IDS.sites.gammaLegacy,
        organizationId: DEMO_IDS.organizations.gamma,
        hostname: "archivio.gamma.it",
        isPrimary: true,
        status: "active",
      },
    ])
    .onConflictDoNothing();

  // 13. Services, StackRevisions, ObservedStates, DockerResources
  // Helpers to seed service stack
  async function seedServiceStack(params: {
    serviceId: string;
    siteId: string;
    organizationId: string;
    templateId: string;
    name: string;
    config: Record<string, unknown>;
    secretRefs?: Record<string, string>;
    desiredStatus: "running" | "stopped";
    observedStatus: string;
    outOfBandModified: boolean;
    dockerRef: string;
  }) {
    const revision = buildImmutableStackRevision({
      serviceInstanceId: params.serviceId,
      organizationId: params.organizationId,
      currentRevisionNumber: 0,
      declarativeConfig: params.config,
      secretRefs: params.secretRefs,
      authorId: DEMO_IDS.users.elena,
    });

    await db
      .insert(serviceInstances)
      .values({
        id: params.serviceId,
        siteId: params.siteId,
        organizationId: params.organizationId,
        serviceTemplateId: params.templateId,
        name: params.name,
        desiredStatus: params.desiredStatus,
        currentRevisionId: revision.id,
      })
      .onConflictDoNothing();

    await db
      .insert(stackRevisions)
      .values({
        id: revision.id,
        serviceInstanceId: params.serviceId,
        organizationId: params.organizationId,
        revisionNumber: revision.revisionNumber,
        specHash: revision.specHash,
        declarativeConfig: revision.declarativeConfig as Record<string, unknown>,
        secretRefs: revision.secretRefs as Record<string, string>,
        resourceLimits: revision.resourceLimits,
        authorId: revision.authorId,
      })
      .onConflictDoNothing();

    await db
      .insert(observedStates)
      .values({
        id: `obs_${params.serviceId}`,
        serviceInstanceId: params.serviceId,
        observedStatus: params.observedStatus,
        observedRevisionHash: revision.specHash,
        outOfBandModified: params.outOfBandModified,
        rawState: { container: params.dockerRef },
        observedAt: now,
      })
      .onConflictDoNothing();

    await db
      .insert(dockerResources)
      .values({
        id: `dock_${params.serviceId}`,
        siteId: params.siteId,
        serviceInstanceId: params.serviceId,
        internalDockerRef: params.dockerRef,
        resourceType: "container",
        status: params.observedStatus,
        metadata: { image: params.templateId },
      })
      .onConflictDoNothing();
  }

  // Site 1: acmeShop (3 services: WordPress + MariaDB + Redis, all in_sync proving F1-004)
  await seedServiceStack({
    serviceId: DEMO_IDS.services.acmeShopWp,
    siteId: DEMO_IDS.sites.acmeShop,
    organizationId: DEMO_IDS.organizations.acme,
    templateId: DEMO_IDS.templates.wordpress,
    name: "Acme Shop WordPress Frontend",
    config: { WP_HOME: "https://negozio.acme.it", DB_NAME: "shop" },
    secretRefs: { DB_PASSWORD: "vault://acme/db/password" },
    desiredStatus: "running",
    observedStatus: "running",
    outOfBandModified: false,
    dockerRef: "cnt_acme_shop_wp_01",
  });

  await seedServiceStack({
    serviceId: DEMO_IDS.services.acmeShopDb,
    siteId: DEMO_IDS.sites.acmeShop,
    organizationId: DEMO_IDS.organizations.acme,
    templateId: DEMO_IDS.templates.mariadb,
    name: "Acme Shop MariaDB Database",
    config: { MYSQL_DATABASE: "shop" },
    secretRefs: { MYSQL_ROOT_PASSWORD: "vault://acme/db/root_password" },
    desiredStatus: "running",
    observedStatus: "running",
    outOfBandModified: false,
    dockerRef: "cnt_acme_shop_db_01",
  });

  await seedServiceStack({
    serviceId: DEMO_IDS.services.acmeShopRedis,
    siteId: DEMO_IDS.sites.acmeShop,
    organizationId: DEMO_IDS.organizations.acme,
    templateId: DEMO_IDS.templates.redis,
    name: "Acme Shop Redis Cache",
    config: { maxmemory: "256mb" },
    desiredStatus: "running",
    observedStatus: "running",
    outOfBandModified: false,
    dockerRef: "cnt_acme_shop_redis_01",
  });

  // Site 2: acmeBlog (WordPress with drifted ObservedState + MariaDB in_sync proving §4.4 drift)
  await seedServiceStack({
    serviceId: DEMO_IDS.services.acmeBlogWp,
    siteId: DEMO_IDS.sites.acmeBlog,
    organizationId: DEMO_IDS.organizations.acme,
    templateId: DEMO_IDS.templates.wordpress,
    name: "Acme Blog WordPress (Drifted)",
    config: { WP_HOME: "https://blog.acme.it", DB_NAME: "blog" },
    secretRefs: { DB_PASSWORD: "vault://acme/blog/password" },
    desiredStatus: "running",
    observedStatus: "running",
    outOfBandModified: true, // DRIFTED out-of-band!
    dockerRef: "cnt_acme_blog_wp_drifted",
  });

  await seedServiceStack({
    serviceId: DEMO_IDS.services.acmeBlogDb,
    siteId: DEMO_IDS.sites.acmeBlog,
    organizationId: DEMO_IDS.organizations.acme,
    templateId: DEMO_IDS.templates.mariadb,
    name: "Acme Blog MariaDB",
    config: { MYSQL_DATABASE: "blog" },
    secretRefs: { MYSQL_ROOT_PASSWORD: "vault://acme/blog/root_password" },
    desiredStatus: "running",
    observedStatus: "running",
    outOfBandModified: false,
    dockerRef: "cnt_acme_blog_db_01",
  });

  // Site 3: betaPortal (Node.js service for AC-F1-02 cross-tenant tests)
  await seedServiceStack({
    serviceId: DEMO_IDS.services.betaPortalNode,
    siteId: DEMO_IDS.sites.betaPortal,
    organizationId: DEMO_IDS.organizations.beta,
    templateId: DEMO_IDS.templates.nodejs,
    name: "Beta Portal Node.js API",
    config: { PORT: "3000" },
    desiredStatus: "running",
    observedStatus: "running",
    outOfBandModified: false,
    dockerRef: "cnt_beta_portal_01",
  });

  // Site 4: gammaLegacy (WordPress stopped on suspended org)
  await seedServiceStack({
    serviceId: DEMO_IDS.services.gammaLegacyApp,
    siteId: DEMO_IDS.sites.gammaLegacy,
    organizationId: DEMO_IDS.organizations.gamma,
    templateId: DEMO_IDS.templates.wordpress,
    name: "Gamma Archivio WordPress",
    config: { WP_HOME: "https://archivio.gamma.it" },
    desiredStatus: "stopped",
    observedStatus: "stopped",
    outOfBandModified: false,
    dockerRef: "cnt_gamma_legacy_01",
  });

  // 14. Initial Audit Event
  await db
    .insert(auditEvents)
    .values({
      id: "aud_seed_01",
      actorId: DEMO_IDS.users.infra,
      actorType: "user",
      organizationId: null,
      action: "platform.seed",
      targetType: "platform_installation",
      targetId: DEMO_IDS.installation,
      details: { spec: "HCP-SPEC-002", phase: "phase-1" },
      timestamp: now,
    })
    .onConflictDoNothing();
}
