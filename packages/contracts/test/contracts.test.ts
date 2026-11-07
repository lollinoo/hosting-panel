import { describe, expect, it } from "vitest";
import {
  ALLOWED_OPERATION_TRANSITIONS,
  AdminFleetItemDtoSchema,
  AdminProviderConnectionDtoSchema,
  ApiErrorEnvelopeSchema,
  ApplicationDetailDtoSchema,
  ApplicationSummaryDtoSchema,
  AsyncAcceptedEnvelopeSchema,
  AuditEventDtoSchema,
  CERTIFICATE_STATUSES,
  CreateInvitationInputSchema,
  CertificateObservationDtoSchema,
  DATABASE_ENGINES,
  DEFAULT_COOLIFY_V4_CAPABILITIES,
  DOMAIN_VERIFICATION_STATUSES,
  DatabaseDetailDtoSchema,
  DatabaseSummaryDtoSchema,
  DeploymentRecordDtoSchema,
  DomainDtoSchema,
  ERROR_CODES,
  ERROR_CODE_HTTP_STATUS,
  FORBIDDEN_PUBLIC_DTO_KEYS,
  GrantEffectSchema,
  MeDtoSchema,
  MemberDtoSchema,
  OBSERVATION_SOURCES,
  OBSERVED_RESOURCE_STATUSES,
  OPERATION_KINDS,
  OPERATION_STATUSES,
  OPERATION_TERMINAL_STATUSES,
  OperationDtoSchema,
  OrganizationCapabilitiesDtoSchema,
  OrganizationDetailDtoSchema,
  OrganizationSummaryDtoSchema,
  PERMISSION_KEYS,
  PRESET_ROLE_NAMES,
  PRESET_ROLE_PERMISSIONS,
  PermissionKeySchema,
  QuotaAllocationDtoSchema,
  RESOURCE_HEALTH_STATUSES,
  RESOURCE_TYPES,
  ServerDtoSchema,
  ServerMetricsDtoSchema,
  TriggerOperationInputSchema,
  canTransitionOperation,
  createErrorEnvelope,
  createPaginatedListSchema,
  createSingleReadSchema,
  findForbiddenPublicDtoKeys,
  getDatabaseBackupCapabilities,
  isMutatingPermission,
  isTerminalOperationStatus,
  type OperationStatus,
  type PermissionKey,
} from "../src/index.js";

const SAMPLE_TIMESTAMP = "2026-11-07T10:00:00.000Z";

describe("@hosting-panel/contracts — permissions & RBAC preset matrices", () => {
  it("defines all 38 HCP-SPEC-001 permission keys plus GrantEffect ('allow' | 'deny')", () => {
    expect(PERMISSION_KEYS).toHaveLength(38);
    expect(new Set(PERMISSION_KEYS).size).toBe(38);

    for (const key of PERMISSION_KEYS) {
      expect(PermissionKeySchema.parse(key)).toBe(key);
    }

    expect(PermissionKeySchema.safeParse("application.shell.exec").success).toBe(false);
    expect(GrantEffectSchema.parse("allow")).toBe("allow");
    expect(GrantEffectSchema.parse("deny")).toBe("deny");
    expect(GrantEffectSchema.safeParse("inherit").success).toBe(false);
  });

  it("freezes PRESET_ROLE_PERMISSIONS and covers all 7 preset roles and all 38 permissions", () => {
    expect(PRESET_ROLE_NAMES).toEqual([
      "customer_owner",
      "hosting_manager",
      "developer",
      "database_manager",
      "billing_manager",
      "viewer",
      "platform_admin",
    ]);
    expect(Object.isFrozen(PRESET_ROLE_PERMISSIONS)).toBe(true);

    const assignedUnion = new Set<PermissionKey>();
    for (const roleName of PRESET_ROLE_NAMES) {
      const perms = PRESET_ROLE_PERMISSIONS[roleName];
      expect(Object.isFrozen(perms)).toBe(true);
      expect(new Set(perms).size).toBe(perms.length);
      for (const perm of perms) {
        assignedUnion.add(perm);
      }
    }

    expect(assignedUnion.size).toBe(PERMISSION_KEYS.length);
  });

  it("enforces viewer is strictly read-only with zero mutating, secret, or admin permissions", () => {
    const viewerPerms = PRESET_ROLE_PERMISSIONS.viewer;
    expect(viewerPerms.length).toBeGreaterThan(0);

    for (const perm of viewerPerms) {
      expect(perm.endsWith(".read")).toBe(true);
      expect(isMutatingPermission(perm)).toBe(false);
    }

    expect(viewerPerms).not.toContain("secrets.read");
    expect(viewerPerms).not.toContain("secrets.write");
    expect(viewerPerms).not.toContain("application.deploy");
    expect(viewerPerms).not.toContain("application.restart");
    expect(viewerPerms).not.toContain("platform.admin");
  });

  it("enforces billing_manager has zero application, database, server, domain, or secret permissions", () => {
    const billingPerms = PRESET_ROLE_PERMISSIONS.billing_manager;
    expect(billingPerms).toEqual([
      "organization.read",
      "billing.read",
      "billing.manage",
      "quota.read",
    ]);

    for (const perm of billingPerms) {
      expect(perm.startsWith("application.")).toBe(false);
      expect(perm.startsWith("database.")).toBe(false);
      expect(perm.startsWith("server.")).toBe(false);
      expect(perm.startsWith("domain.")).toBe(false);
      expect(perm.startsWith("secrets.")).toBe(false);
    }
  });

  it("enforces developer, database_manager, customer_owner, and platform_admin separation of duties", () => {
    expect(PRESET_ROLE_PERMISSIONS.developer).toEqual([
      "organization.read",
      "application.read",
      "application.deploy",
      "application.restart",
      "application.logs.read",
      "domain.read",
      "certificate.read",
      "operation.read",
    ]);

    expect(PRESET_ROLE_PERMISSIONS.database_manager).toEqual([
      "organization.read",
      "database.read",
      "database.credentials.rotate",
      "database.backup.read",
      "database.backup.create",
      "database.backup.restore",
      "operation.read",
    ]);

    expect(PRESET_ROLE_PERMISSIONS.customer_owner).toContain("support.impersonation.approve");
    expect(PRESET_ROLE_PERMISSIONS.customer_owner).not.toContain("support.impersonation.request");
    expect(PRESET_ROLE_PERMISSIONS.customer_owner).not.toContain("platform.admin");

    expect(PRESET_ROLE_PERMISSIONS.platform_admin).toContain("platform.admin");
    expect(PRESET_ROLE_PERMISSIONS.platform_admin).toContain("support.impersonation.request");
    expect(PRESET_ROLE_PERMISSIONS.platform_admin).not.toContain("support.impersonation.approve");
  });
});

describe("@hosting-panel/contracts — normalized error codes & envelopes", () => {
  it("validates all 15 normalized error codes and HTTP status mappings", () => {
    expect(ERROR_CODES).toHaveLength(15);
    for (const code of ERROR_CODES) {
      expect(ERROR_CODE_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
      expect(ERROR_CODE_HTTP_STATUS[code]).toBeLessThan(600);
    }
  });

  it("constructs and validates ApiErrorEnvelope with default retryability and sanitized details", () => {
    const rateLimitEnvelope = createErrorEnvelope({
      code: "PROVIDER_RATE_LIMIT",
      message: "Upstream rate limit reached; retry later.",
      requestId: "req_01J9XYZ",
      details: [{ message: "Retry after 15 seconds", reason: "retry_after" }],
    });

    expect(rateLimitEnvelope).toEqual({
      error: {
        code: "PROVIDER_RATE_LIMIT",
        message: "Upstream rate limit reached; retry later.",
        requestId: "req_01J9XYZ",
        retryable: true,
        details: [{ message: "Retry after 15 seconds", reason: "retry_after" }],
      },
    });

    const deniedEnvelope = createErrorEnvelope({
      code: "PERMISSION_DENIED",
      message: "Missing permission application.deploy",
      requestId: "req_01J9ABC",
    });
    expect(deniedEnvelope.error.retryable).toBe(false);
    expect(deniedEnvelope.error.details).toEqual([]);

    expect(
      ApiErrorEnvelopeSchema.safeParse({
        error: {
          code: "RAW_COOLIFY_500",
          message: "Bad code",
          requestId: "req_1",
          retryable: false,
          details: [],
        },
      }).success,
    ).toBe(false);
  });
});

describe("@hosting-panel/contracts — 8-state operation state machine & envelopes", () => {
  it("identifies terminal vs non-terminal statuses accurately (unknown is non-terminal)", () => {
    expect(OPERATION_STATUSES).toHaveLength(8);
    expect(OPERATION_TERMINAL_STATUSES).toEqual(["succeeded", "failed", "cancelled"]);
    expect(OPERATION_KINDS).toEqual([
      "application.deploy",
      "application.restart",
      "domain.recheck",
      "provider.connection.test",
    ]);

    expect(isTerminalOperationStatus("succeeded")).toBe(true);
    expect(isTerminalOperationStatus("failed")).toBe(true);
    expect(isTerminalOperationStatus("cancelled")).toBe(true);

    expect(isTerminalOperationStatus("queued")).toBe(false);
    expect(isTerminalOperationStatus("processing")).toBe(false);
    expect(isTerminalOperationStatus("accepted_by_provider")).toBe(false);
    expect(isTerminalOperationStatus("reconciling")).toBe(false);
    expect(isTerminalOperationStatus("unknown")).toBe(false);
  });

  it("enforces the exact HCP-SPEC-001 §8.1 transition matrix across all 64 (from, to) pairs", () => {
    const expectedMap: Record<OperationStatus, readonly OperationStatus[]> = {
      queued: ["processing", "cancelled"],
      processing: ["accepted_by_provider", "failed", "unknown"],
      accepted_by_provider: ["reconciling", "unknown"],
      reconciling: ["succeeded", "failed", "unknown", "cancelled"],
      unknown: ["reconciling", "failed"],
      succeeded: [],
      failed: [],
      cancelled: [],
    };

    expect(ALLOWED_OPERATION_TRANSITIONS).toEqual(expectedMap);

    for (const from of OPERATION_STATUSES) {
      for (const to of OPERATION_STATUSES) {
        const expected = expectedMap[from].includes(to);
        expect(canTransitionOperation(from, to)).toBe(expected);
      }
    }

    // Explicit critical transitions:
    expect(canTransitionOperation("unknown", "reconciling")).toBe(true);
    expect(canTransitionOperation("unknown", "failed")).toBe(true);
    expect(canTransitionOperation("unknown", "succeeded")).toBe(false);
    expect(canTransitionOperation("queued", "succeeded")).toBe(false);
    expect(canTransitionOperation("accepted_by_provider", "succeeded")).toBe(false);

    // Terminal immutability:
    for (const terminal of OPERATION_TERMINAL_STATUSES) {
      for (const target of OPERATION_STATUSES) {
        expect(canTransitionOperation(terminal, target)).toBe(false);
      }
    }
  });

  it("validates AsyncAcceptedEnvelopeSchema (202 Accepted) and OperationDtoSchema", () => {
    const accepted = AsyncAcceptedEnvelopeSchema.parse({
      data: {
        operationId: "op_01",
        status: "queued",
        resourceId: "app_01",
        submittedAt: SAMPLE_TIMESTAMP,
      },
      links: {
        self: "/v1/organizations/org_01/operations/op_01",
      },
    });
    expect(accepted.data.status).toBe("queued");

    const opDto = OperationDtoSchema.parse({
      id: "op_01",
      organizationId: "org_01",
      kind: "application.deploy",
      status: "reconciling",
      resourceType: "application",
      resourceId: "app_01",
      requestedByUserId: "usr_01",
      errorCode: null,
      errorMessage: null,
      submittedAt: SAMPLE_TIMESTAMP,
      startedAt: SAMPLE_TIMESTAMP,
      completedAt: null,
      updatedAt: "2026-11-07T11:00:00+01:00",
      steps: [
        {
          id: "step_01",
          key: "dispatch_provider",
          label: "Invio richiesta di deploy",
          status: "succeeded",
          message: null,
          startedAt: SAMPLE_TIMESTAMP,
          completedAt: SAMPLE_TIMESTAMP,
        },
      ],
    });
    expect(opDto.steps).toHaveLength(1);
  });
});

describe("@hosting-panel/contracts — public /v1 DTOs, capabilities & envelopes", () => {
  it("exports canonical resource enums and enforces Redis backup unsupported (HCP-SPEC-001 §9.2 / AC-012)", () => {
    expect(OBSERVED_RESOURCE_STATUSES).toContain("degraded");
    expect(RESOURCE_HEALTH_STATUSES).toEqual(["healthy", "unhealthy", "unknown"]);
    expect(OBSERVATION_SOURCES).toEqual(["coolify", "monitoring", "external_probe"]);
    expect(RESOURCE_TYPES).toEqual(["application", "database"]);
    expect(CERTIFICATE_STATUSES).toContain("expiring_soon");
    expect(DOMAIN_VERIFICATION_STATUSES).toContain("verified");
    expect(DATABASE_ENGINES).toContain("redis");

    expect(DEFAULT_COOLIFY_V4_CAPABILITIES.databaseBackupByEngine.redis.supported).toBe(false);
    expect(DEFAULT_COOLIFY_V4_CAPABILITIES.databaseBackupByEngine.postgresql.supported).toBe(true);

    const redisCaps = getDatabaseBackupCapabilities("redis");
    expect(redisCaps.backupSupported).toBe(false);
    expect(redisCaps.restoreSupported).toBe(false);
    expect(redisCaps.backupUnsupportedReason).toBeTruthy();

    const pgCaps = getDatabaseBackupCapabilities("postgresql");
    expect(pgCaps.backupSupported).toBe(true);
    expect(pgCaps.restoreSupported).toBe(true);
    expect(pgCaps.backupUnsupportedReason).toBeNull();
  });

  it("validates single read and cursor-paginated list envelopes with optional ReadMeta", () => {
    const SingleServerEnvelope = createSingleReadSchema(ServerDtoSchema);
    const PaginatedAppsEnvelope = createPaginatedListSchema(ApplicationSummaryDtoSchema);

    const singleParsed = SingleServerEnvelope.parse({
      data: {
        id: "srv_01",
        organizationId: "org_01",
        name: "milano-prod-01",
        region: "eu-south-1",
        publicIpv4: "203.0.113.10",
        status: "running",
        health: "healthy",
        vcpuCount: 4,
        memoryMb: 8192,
        diskGb: 160,
        lastObservedAt: SAMPLE_TIMESTAMP,
        createdAt: SAMPLE_TIMESTAMP,
      },
      meta: {
        observedAt: SAMPLE_TIMESTAMP,
        source: "coolify",
        stale: false,
      },
    });
    expect(singleParsed.meta?.source).toBe("coolify");

    const listParsed = PaginatedAppsEnvelope.parse({
      data: [
        {
          id: "app_01",
          organizationId: "org_01",
          serverId: "srv_01",
          name: "Portale Clienti",
          slug: "portale-clienti",
          environment: "production",
          status: "running",
          health: "healthy",
          primaryDomain: "app.esempio.it",
          lastDeployedAt: SAMPLE_TIMESTAMP,
          lastObservedAt: SAMPLE_TIMESTAMP,
          lockedByOperationId: null,
          createdAt: SAMPLE_TIMESTAMP,
        },
      ],
      page: {
        nextCursor: null,
        hasMore: false,
      },
      meta: {
        observedAt: SAMPLE_TIMESTAMP,
        source: "coolify",
        stale: false,
      },
    });
    expect(listParsed.data).toHaveLength(1);
    expect(listParsed.page.hasMore).toBe(false);
  });

  it("validates all /v1 tenant & admin DTO schemas cleanly", () => {
    expect(
      MeDtoSchema.parse({
        user: {
          id: "usr_01",
          email: "anna@esempio.it",
          displayName: "Anna Rossi",
          isPlatformAdmin: false,
        },
        memberships: [
          {
            organizationId: "org_01",
            organizationSlug: "acme-italia",
            organizationName: "Acme Italia S.r.l.",
            organizationType: "customer",
            organizationStatus: "active",
            roles: ["customer_owner"],
            permissions: ["organization.read", "application.read", "application.deploy"],
          },
        ],
      }).user.email,
    ).toBe("anna@esempio.it");

    expect(
      OrganizationSummaryDtoSchema.parse({
        id: "org_01",
        slug: "acme-italia",
        name: "Acme Italia S.r.l.",
        type: "customer",
        status: "active",
        createdAt: SAMPLE_TIMESTAMP,
      }).slug,
    ).toBe("acme-italia");

    expect(
      OrganizationDetailDtoSchema.parse({
        id: "org_01",
        slug: "acme-italia",
        name: "Acme Italia S.r.l.",
        type: "customer",
        status: "active",
        primaryLocale: "it-IT",
        memberCount: 3,
        serverCount: 1,
        applicationCount: 2,
        databaseCount: 2,
        createdAt: SAMPLE_TIMESTAMP,
        updatedAt: SAMPLE_TIMESTAMP,
      }).primaryLocale,
    ).toBe("it-IT");

    expect(
      OrganizationCapabilitiesDtoSchema.parse({
        organizationId: "org_01",
        permissions: ["organization.read", "application.read"],
        features: DEFAULT_COOLIFY_V4_CAPABILITIES,
        evaluatedAt: SAMPLE_TIMESTAMP,
      }).features.databaseBackupByEngine.redis.supported,
    ).toBe(false);

    expect(
      MemberDtoSchema.parse({
        membershipId: "mem_01",
        organizationId: "org_01",
        userId: "usr_01",
        email: "anna@esempio.it",
        displayName: "Anna Rossi",
        roles: ["customer_owner"],
        joinedAt: SAMPLE_TIMESTAMP,
      }).membershipId,
    ).toBe("mem_01");

    expect(
      ServerMetricsDtoSchema.parse({
        serverId: "srv_01",
        cpuUsagePercent: 24.5,
        memoryUsedMb: 3200,
        memoryTotalMb: 8192,
        diskUsedGb: 42,
        diskTotalGb: 160,
        uptimeSeconds: 86400,
        observedAt: SAMPLE_TIMESTAMP,
      }).cpuUsagePercent,
    ).toBe(24.5);

    const deployment = DeploymentRecordDtoSchema.parse({
      id: "dep_01",
      applicationId: "app_01",
      operationId: "op_01",
      commitSha: "a1b2c3d",
      imageTag: "v1.4.0",
      status: "succeeded",
      triggeredByUserId: "usr_01",
      startedAt: SAMPLE_TIMESTAMP,
      finishedAt: SAMPLE_TIMESTAMP,
      createdAt: SAMPLE_TIMESTAMP,
    });

    expect(
      ApplicationDetailDtoSchema.parse({
        id: "app_01",
        organizationId: "org_01",
        serverId: "srv_01",
        name: "Portale Clienti",
        slug: "portale-clienti",
        environment: "production",
        status: "running",
        health: "healthy",
        primaryDomain: "app.esempio.it",
        lastDeployedAt: SAMPLE_TIMESTAMP,
        lastObservedAt: SAMPLE_TIMESTAMP,
        lockedByOperationId: null,
        createdAt: SAMPLE_TIMESTAMP,
        repositoryUrl: "https://github.com/esempio/portale",
        branch: "main",
        buildPack: "dockerfile",
        domains: ["app.esempio.it"],
        allowedActions: {
          canDeploy: true,
          canRestart: true,
          canStop: false,
          canReadLogs: true,
        },
        recentDeployments: [deployment],
        updatedAt: SAMPLE_TIMESTAMP,
      }).recentDeployments,
    ).toHaveLength(1);

    expect(
      DatabaseSummaryDtoSchema.parse({
        id: "db_redis_01",
        organizationId: "org_01",
        serverId: "srv_01",
        name: "cache-sessioni",
        engine: "redis",
        engineVersion: "7.4",
        status: "running",
        health: "healthy",
        backupSupported: false,
        restoreSupported: false,
        lastBackupAt: null,
        lastObservedAt: SAMPLE_TIMESTAMP,
        createdAt: SAMPLE_TIMESTAMP,
      }).backupSupported,
    ).toBe(false);

    expect(
      DatabaseDetailDtoSchema.parse({
        id: "db_redis_01",
        organizationId: "org_01",
        serverId: "srv_01",
        name: "cache-sessioni",
        engine: "redis",
        engineVersion: "7.4",
        status: "running",
        health: "healthy",
        backupSupported: false,
        restoreSupported: false,
        lastBackupAt: null,
        lastObservedAt: SAMPLE_TIMESTAMP,
        createdAt: SAMPLE_TIMESTAMP,
        storageAllocatedGb: 10,
        internalHostname: "redis-cache.internal",
        port: 6379,
        backupUnsupportedReason:
          "Automated backups and restores are not supported for Redis instances.",
        updatedAt: SAMPLE_TIMESTAMP,
      }).restoreSupported,
    ).toBe(false);

    const cert = CertificateObservationDtoSchema.parse({
      id: "cert_01",
      domainId: "dom_01",
      organizationId: "org_01",
      hostname: "app.esempio.it",
      status: "valid",
      issuer: "Let's Encrypt",
      validFrom: SAMPLE_TIMESTAMP,
      expiresAt: SAMPLE_TIMESTAMP,
      observedAt: SAMPLE_TIMESTAMP,
      source: "coolify",
    });

    expect(
      DomainDtoSchema.parse({
        id: "dom_01",
        organizationId: "org_01",
        applicationId: "app_01",
        hostname: "app.esempio.it",
        isPrimary: true,
        verificationStatus: "verified",
        httpsEnabled: true,
        certificate: cert,
        createdAt: SAMPLE_TIMESTAMP,
        updatedAt: SAMPLE_TIMESTAMP,
      }).certificate?.status,
    ).toBe("valid");

    expect(
      QuotaAllocationDtoSchema.parse({
        organizationId: "org_01",
        planCode: "business-it",
        serversUsed: 1,
        serversLimit: 3,
        applicationsUsed: 2,
        applicationsLimit: 10,
        databasesUsed: 2,
        databasesLimit: 5,
        domainsUsed: 2,
        domainsLimit: 20,
        updatedAt: SAMPLE_TIMESTAMP,
      }).planCode,
    ).toBe("business-it");

    expect(
      AdminFleetItemDtoSchema.parse({
        resourceId: "app_01",
        resourceType: "application",
        resourceName: "Portale Clienti",
        organizationId: "org_01",
        organizationName: "Acme Italia S.r.l.",
        serverId: "srv_01",
        serverName: "milano-prod-01",
        status: "running",
        health: "healthy",
        stale: false,
        lastObservedAt: SAMPLE_TIMESTAMP,
      }).resourceType,
    ).toBe("application");
  });
});

describe("@hosting-panel/contracts — adversarial negative security invariants (zero secret/provider leakage)", () => {
  it("guarantees zero public DTO schema shapes define providerId, coolifyUuid, secretRef, token, or baseUrl", () => {
    const publicDtoSchemas = [
      MeDtoSchema,
      OrganizationSummaryDtoSchema,
      OrganizationDetailDtoSchema,
      OrganizationCapabilitiesDtoSchema,
      MemberDtoSchema,
      ServerDtoSchema,
      ServerMetricsDtoSchema,
      ApplicationSummaryDtoSchema,
      ApplicationDetailDtoSchema,
      DeploymentRecordDtoSchema,
      DatabaseSummaryDtoSchema,
      DatabaseDetailDtoSchema,
      DomainDtoSchema,
      CertificateObservationDtoSchema,
      QuotaAllocationDtoSchema,
      AuditEventDtoSchema,
      AdminProviderConnectionDtoSchema,
      AdminFleetItemDtoSchema,
      OperationDtoSchema,
    ];

    const forbiddenSet = new Set<string>(FORBIDDEN_PUBLIC_DTO_KEYS);
    for (const schema of publicDtoSchemas) {
      for (const key of Object.keys(schema.shape)) {
        expect(forbiddenSet.has(key)).toBe(false);
      }
    }
  });

  it("strictly REJECTS unknown/injected secret or provider fields on mutation input schemas", () => {
    expect(
      CreateInvitationInputSchema.safeParse({
        email: "dev@esempio.it",
        roles: ["developer"],
      }).success,
    ).toBe(true);

    expect(
      CreateInvitationInputSchema.safeParse({
        email: "dev@esempio.it",
        roles: ["developer"],
        providerId: "prov_internal_01",
      }).success,
    ).toBe(false);

    expect(
      CreateInvitationInputSchema.safeParse({
        email: "dev@esempio.it",
        roles: ["developer"],
        coolifyToken: "Bearer secret-token",
      }).success,
    ).toBe(false);

    expect(TriggerOperationInputSchema.safeParse({}).success).toBe(true);
    expect(
      TriggerOperationInputSchema.safeParse({
        reason: "Rilascio versione 1.2",
        forceRebuild: true,
      }).success,
    ).toBe(true);

    expect(
      TriggerOperationInputSchema.safeParse({
        reason: "Rilascio",
        providerId: "prov_internal_01",
        coolifyToken: "super-secret-coolify-pat",
      }).success,
    ).toBe(false);
  });

  it("STRIPS providerId, coolifyUuid, secretRef, coolifyToken, and providerBaseUrl from serialized output DTOs", () => {
    const rawInternalProviderRow = {
      id: "conn_01",
      displayName: "Cluster Primario Milano",
      driver: "coolify-v4" as const,
      status: "connected" as const,
      version: "4.0.0-beta.380",
      capabilities: DEFAULT_COOLIFY_V4_CAPABILITIES,
      boundOrganizationCount: 4,
      lastCheckedAt: SAMPLE_TIMESTAMP,
      createdAt: SAMPLE_TIMESTAMP,
      // Dangerous internal fields that MUST never survive DTO serialization:
      providerId: "prov_secret_01",
      coolifyUuid: "coolify_uuid_999",
      secretRef: "env://COOLIFY_PRIMARY_TOKEN",
      coolifyToken: "1|plainTextCoolifyBearerToken",
      token: "1|plainTextCoolifyBearerToken",
      providerBaseUrl: "https://coolify-internal.private.lan:8000",
    };

    const sanitizedAdminProvider = AdminProviderConnectionDtoSchema.parse(rawInternalProviderRow);
    expect(findForbiddenPublicDtoKeys(sanitizedAdminProvider)).toEqual([]);
    expect("providerId" in sanitizedAdminProvider).toBe(false);
    expect("coolifyUuid" in sanitizedAdminProvider).toBe(false);
    expect("secretRef" in sanitizedAdminProvider).toBe(false);
    expect("coolifyToken" in sanitizedAdminProvider).toBe(false);
    expect("token" in sanitizedAdminProvider).toBe(false);
    expect("providerBaseUrl" in sanitizedAdminProvider).toBe(false);

    const rawInternalServerRow = {
      id: "srv_01",
      organizationId: "org_01",
      name: "milano-prod-01",
      region: "eu-south-1",
      publicIpv4: "203.0.113.10",
      status: "running" as const,
      health: "healthy" as const,
      vcpuCount: 4,
      memoryMb: 8192,
      diskGb: 160,
      lastObservedAt: SAMPLE_TIMESTAMP,
      createdAt: SAMPLE_TIMESTAMP,
      providerId: "prov_secret_01",
      coolifyUuid: "srv_coolify_uuid_123",
      coolifyToken: "1|secret",
    };

    const sanitizedServer = ServerDtoSchema.parse(rawInternalServerRow);
    expect(findForbiddenPublicDtoKeys(sanitizedServer)).toEqual([]);
    expect("providerId" in sanitizedServer).toBe(false);
    expect("coolifyUuid" in sanitizedServer).toBe(false);
    expect("coolifyToken" in sanitizedServer).toBe(false);
  });

  it("REJECTS forbidden secret and provider keys inside AuditEventDtoSchema.metadata", () => {
    const baseAudit = {
      id: "aud_01",
      organizationId: "org_01",
      actorUserId: "usr_01",
      actorEmail: "anna@esempio.it",
      impersonatedByUserId: null,
      action: "application.deploy.requested",
      targetType: "application",
      targetId: "app_01",
      outcome: "allowed" as const,
      requestId: "req_01",
      ipAddress: "203.0.113.55",
      occurredAt: SAMPLE_TIMESTAMP,
    };

    expect(
      AuditEventDtoSchema.safeParse({
        ...baseAudit,
        metadata: {
          environment: "production",
          operationId: "op_01",
        },
      }).success,
    ).toBe(true);

    for (const forbiddenKey of [
      "providerId",
      "coolifyUuid",
      "secretRef",
      "coolifyToken",
      "authorization",
      "password",
      "providerBaseUrl",
    ]) {
      const result = AuditEventDtoSchema.safeParse({
        ...baseAudit,
        metadata: {
          [forbiddenKey]: "leaked-sensitive-value",
        },
      });
      expect(result.success).toBe(false);
    }
  });
});
