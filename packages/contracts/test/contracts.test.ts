import { describe, expect, it } from "vitest";
import {
  ApiErrorEnvelopeSchema,
  DEFAULT_PLATFORM_CAPABILITIES,
  ERROR_CODES,
  ERROR_CODE_HTTP_STATUS,
  EncryptedSecretMetadataDtoSchema,
  GrantEffectSchema,
  HostAllocationDtoSchema,
  HostDaemonHeartbeatDtoSchema,
  HostDtoSchema,
  HostTelemetryDtoSchema,
  OPERATION_KINDS,
  OPERATION_STATUSES,
  OperationDtoSchema,
  PERMISSION_KEYS,
  PRESET_ROLE_NAMES,
  PRESET_ROLE_PERMISSIONS,
  PermissionKeySchema,
  PlatformCapabilitiesDtoSchema,
  RUNTIME_BACKENDS,
  ServiceTemplateDtoSchema,
  SiteDetailDtoSchema,
  UpsertEncryptedSecretInputSchema,
  canTransitionOperation,
  createErrorEnvelope,
  createPlatformCapabilities,
  findForbiddenPublicDtoKeys,
  findPlaintextSecretKeys,
  findUnsafeDockerInputFields,
  isDefaultRetryableErrorCode,
  isMutatingPermission,
  isTerminalOperationStatus,
  redactSensitiveString,
  redactSensitiveValue,
} from "../src/index.js";

const SAMPLE_TIMESTAMP = "2026-11-07T10:00:00.000Z";

describe("@hosting-panel/contracts — Permissions & RBAC Presets", () => {
  it("defines exactly 33 canonical HCP-SPEC-002 permission keys", () => {
    expect(PERMISSION_KEYS).toHaveLength(33);
    expect(new Set(PERMISSION_KEYS).size).toBe(33);

    for (const key of PERMISSION_KEYS) {
      expect(PermissionKeySchema.parse(key)).toBe(key);
    }

    expect(PermissionKeySchema.safeParse("arbitrary.permission").success).toBe(false);
  });

  it("defines 4 explicit roles in PRESET_ROLE_NAMES", () => {
    expect(PRESET_ROLE_NAMES).toEqual([
      "infrastructure_admin",
      "hosting_admin",
      "customer_owner",
      "customer_collaborator",
    ]);
  });

  it("enforces infrastructure_admin has platform host/allocation access but NO customer site/service permissions", () => {
    const infraPerms = PRESET_ROLE_PERMISSIONS.infrastructure_admin;
    expect(infraPerms).toContain("host.read");
    expect(infraPerms).toContain("host.maintenance.execute");
    expect(infraPerms).toContain("host.security.manage");
    expect(infraPerms).toContain("host.docker.engine.manage");
    expect(infraPerms).toContain("allocation.create");
    expect(infraPerms).toContain("template.read");
    expect(infraPerms).toContain("quota.read");
    expect(infraPerms).toContain("operation.read");
    expect(infraPerms).toContain("audit.read");

    // Strictly NO customer site/service permissions
    expect(infraPerms.some((p) => p.startsWith("site."))).toBe(false);
    expect(infraPerms.some((p) => p.startsWith("service."))).toBe(false);
    expect(infraPerms.some((p) => p.startsWith("organization."))).toBe(false);
  });

  it("enforces hosting_admin has hosting domain permissions but is strictly excluded from host maintenance and security (AC-F1-03)", () => {
    const hostingPerms = PRESET_ROLE_PERMISSIONS.hosting_admin;
    expect(hostingPerms).toContain("host.read");
    expect(hostingPerms).toContain("host.metrics.read");
    expect(hostingPerms).toContain("host.docker.read");
    expect(hostingPerms).toContain("allocation.create");
    expect(hostingPerms).toContain("template.manage");
    expect(hostingPerms).toContain("site.create");
    expect(hostingPerms).toContain("service.deploy");
    expect(hostingPerms).toContain("quota.manage");

    // Strictly EXCLUDED per AC-F1-03
    expect(hostingPerms).not.toContain("host.maintenance.read");
    expect(hostingPerms).not.toContain("host.maintenance.execute");
    expect(hostingPerms).not.toContain("host.security.read");
    expect(hostingPerms).not.toContain("host.security.manage");
    expect(hostingPerms).not.toContain("host.docker.engine.manage");
  });

  it("enforces customer_owner and customer_collaborator boundary", () => {
    const ownerPerms = PRESET_ROLE_PERMISSIONS.customer_owner;
    expect(ownerPerms).toContain("organization.read");
    expect(ownerPerms).toContain("organization.members.manage");
    expect(ownerPerms).toContain("site.create");
    expect(ownerPerms).toContain("service.create");
    expect(ownerPerms).not.toContain("host.maintenance.execute");
    expect(ownerPerms).not.toContain("template.manage");

    const collabPerms = PRESET_ROLE_PERMISSIONS.customer_collaborator;
    expect(collabPerms).toEqual([
      "organization.read",
      "template.read",
      "quota.read",
      "operation.read",
    ]);
  });

  it("correctly identifies mutating vs read-only permissions", () => {
    expect(isMutatingPermission("host.read")).toBe(false);
    expect(isMutatingPermission("site.read")).toBe(false);
    expect(isMutatingPermission("service.read")).toBe(false);
    expect(isMutatingPermission("site.create")).toBe(true);
    expect(isMutatingPermission("service.deploy")).toBe(true);
    expect(isMutatingPermission("host.maintenance.execute")).toBe(true);
  });

  it("validates GrantEffect schema", () => {
    expect(GrantEffectSchema.parse("allow")).toBe("allow");
    expect(GrantEffectSchema.parse("deny")).toBe("deny");
    expect(GrantEffectSchema.safeParse("unknown").success).toBe(false);
  });
});

describe("@hosting-panel/contracts — Errors & HTTP Status Mapping", () => {
  it("defines all canonical HCP-SPEC-002 & HCP-SPEC-003 error codes with zero legacy artifacts", () => {
    expect(ERROR_CODES).toEqual([
      "UNAUTHENTICATED",
      "PERMISSION_DENIED",
      "HOST_POLICY_DENIED",
      "ORGANIZATION_SUSPENDED",
      "NOT_FOUND",
      "VALIDATION_ERROR",
      "IDEMPOTENCY_CONFLICT",
      "RESOURCE_LOCKED",
      "QUOTA_EXCEEDED",
      "DEDICATED_HOST_OCCUPIED",
      "SHARED_MODE_GATED",
      "DOMAIN_CONFLICT",
      "LAST_OWNER_PROTECTED",
      "NOT_SUPPORTED",
      "OPERATION_INTERRUPTED",
      "OPERATION_AMBIGUOUS",
      "DOCKER_ENGINE_UNAVAILABLE",
      "HOST_AGENT_UNAVAILABLE",
      "MAIL_RELAY_UNAVAILABLE",
      "INTERNAL_ERROR",
      "INVALID_CREDENTIALS",
      "ACCOUNT_LOCKED",
      "TOTP_INVALID",
      "ACCOUNT_SETUP_INCOMPLETE",
    ]);

    for (const code of ERROR_CODES) {
      expect(typeof ERROR_CODE_HTTP_STATUS[code]).toBe("number");
      expect(ERROR_CODE_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
      expect(ERROR_CODE_HTTP_STATUS[code]).toBeLessThan(600);
    }
    expect(ERROR_CODE_HTTP_STATUS.OPERATION_INTERRUPTED).toBe(409);
    expect(ERROR_CODE_HTTP_STATUS.ACCOUNT_LOCKED).toBe(423);
  });

  it("maps status codes accurately", () => {
    expect(ERROR_CODE_HTTP_STATUS.UNAUTHENTICATED).toBe(401);
    expect(ERROR_CODE_HTTP_STATUS.PERMISSION_DENIED).toBe(403);
    expect(ERROR_CODE_HTTP_STATUS.HOST_POLICY_DENIED).toBe(403);
    expect(ERROR_CODE_HTTP_STATUS.ORGANIZATION_SUSPENDED).toBe(403);
    expect(ERROR_CODE_HTTP_STATUS.NOT_FOUND).toBe(404);
    expect(ERROR_CODE_HTTP_STATUS.VALIDATION_ERROR).toBe(400);
    expect(ERROR_CODE_HTTP_STATUS.DEDICATED_HOST_OCCUPIED).toBe(409);
    expect(ERROR_CODE_HTTP_STATUS.SHARED_MODE_GATED).toBe(409);
    expect(ERROR_CODE_HTTP_STATUS.NOT_SUPPORTED).toBe(422);
    expect(ERROR_CODE_HTTP_STATUS.OPERATION_AMBIGUOUS).toBe(502);
    expect(ERROR_CODE_HTTP_STATUS.DOCKER_ENGINE_UNAVAILABLE).toBe(503);
    expect(ERROR_CODE_HTTP_STATUS.HOST_AGENT_UNAVAILABLE).toBe(503);
  });

  it("checks default retryable error codes", () => {
    expect(isDefaultRetryableErrorCode("RESOURCE_LOCKED")).toBe(true);
    expect(isDefaultRetryableErrorCode("DOCKER_ENGINE_UNAVAILABLE")).toBe(true);
    expect(isDefaultRetryableErrorCode("HOST_AGENT_UNAVAILABLE")).toBe(true);
    expect(isDefaultRetryableErrorCode("VALIDATION_ERROR")).toBe(false);
    expect(isDefaultRetryableErrorCode("NOT_FOUND")).toBe(false);
  });

  it("creates structured ApiErrorEnvelope", () => {
    const env = createErrorEnvelope({
      code: "NOT_FOUND",
      message: "Resource not found",
      requestId: "req-123",
      details: [{ field: "siteId", message: "Site does not exist" }],
    });
    expect(ApiErrorEnvelopeSchema.parse(env)).toEqual(env);
    expect(env.error.code).toBe("NOT_FOUND");
    expect(env.error.retryable).toBe(false);
  });
});

describe("@hosting-panel/contracts — Operations & State Transitions", () => {
  it("defines canonical operations lifecycle", () => {
    expect(OPERATION_STATUSES).toEqual([
      "queued",
      "processing",
      "accepted",
      "reconciling",
      "succeeded",
      "failed",
      "unknown",
      "cancelled",
    ]);

    expect(isTerminalOperationStatus("succeeded")).toBe(true);
    expect(isTerminalOperationStatus("failed")).toBe(true);
    expect(isTerminalOperationStatus("cancelled")).toBe(true);
    expect(isTerminalOperationStatus("processing")).toBe(false);
    expect(isTerminalOperationStatus("unknown")).toBe(false);
  });

  it("enforces valid transitions", () => {
    expect(canTransitionOperation("queued", "processing")).toBe(true);
    expect(canTransitionOperation("queued", "cancelled")).toBe(true);
    expect(canTransitionOperation("queued", "succeeded")).toBe(false);

    expect(canTransitionOperation("processing", "accepted")).toBe(true);
    expect(canTransitionOperation("processing", "reconciling")).toBe(true);
    expect(canTransitionOperation("processing", "unknown")).toBe(true);

    expect(canTransitionOperation("accepted", "reconciling")).toBe(true);
    expect(canTransitionOperation("reconciling", "succeeded")).toBe(true);
    expect(canTransitionOperation("reconciling", "failed")).toBe(true);
    expect(canTransitionOperation("reconciling", "unknown")).toBe(true);

    expect(canTransitionOperation("unknown", "reconciling")).toBe(true);
    expect(canTransitionOperation("unknown", "failed")).toBe(true);

    expect(canTransitionOperation("succeeded", "reconciling")).toBe(false);
  });

  it("parses valid OperationDto", () => {
    const op = {
      id: "op-1",
      organizationId: "org-1",
      kind: "service.deploy" as const,
      status: "reconciling" as const,
      resourceType: "service" as const,
      resourceId: "svc-1",
      requestedByUserId: "usr-1",
      errorCode: null,
      errorMessage: null,
      submittedAt: SAMPLE_TIMESTAMP,
      startedAt: SAMPLE_TIMESTAMP,
      completedAt: null,
      updatedAt: SAMPLE_TIMESTAMP,
      steps: [
        {
          id: "step-1",
          key: "validate",
          label: "Validation",
          status: "succeeded" as const,
          message: null,
          startedAt: SAMPLE_TIMESTAMP,
          completedAt: SAMPLE_TIMESTAMP,
        },
      ],
    };
    expect(OperationDtoSchema.parse(op)).toEqual(op);
  });
});

describe("@hosting-panel/contracts — Security Guards & Redaction", () => {
  it("detects forbidden public DTO keys including internal docker refs, ciphertext fields, and resolved secrets", () => {
    const payload = {
      name: "WordPress",
      dockerContainerId: "cnt-123456",
      internalDockerRef: "dock-ref",
      ciphertext: "abc",
      ciphertextBase64: "YWJj",
      ivBase64: "MTIzNDU2Nzg5MDEy",
      authTagBase64: "MTIzNDU2Nzg5MDEyMzQ1Ng==",
      secretValue: "raw-val",
      resolvedSecrets: { DB_PASS: "top-secret" },
      snake: {
        ciphertext_base64: "YWJj",
        iv_base64: "MTIz",
        auth_tag_base64: "NDU2",
        secret_value: "raw",
        resolved_secrets: { A: "B" },
      },
      config: {
        password: "secret-value",
        bindMount: "/var/lib/data",
      },
      list: [{ apiKey: "key-123" }],
    };

    const violations = findForbiddenPublicDtoKeys(payload);
    expect(violations).toContain("dockerContainerId");
    expect(violations).toContain("internalDockerRef");
    expect(violations).toContain("ciphertext");
    expect(violations).toContain("ciphertextBase64");
    expect(violations).toContain("ivBase64");
    expect(violations).toContain("authTagBase64");
    expect(violations).toContain("secretValue");
    expect(violations).toContain("resolvedSecrets");
    expect(violations).toContain("snake.ciphertext_base64");
    expect(violations).toContain("snake.iv_base64");
    expect(violations).toContain("snake.auth_tag_base64");
    expect(violations).toContain("snake.secret_value");
    expect(violations).toContain("snake.resolved_secrets");
    expect(violations).toContain("config.password");
    expect(violations).toContain("config.bindMount");
    expect(violations).toContain("list[0].apiKey");
  });

  it("detects unsafe Docker input fields (AC-F1-04)", () => {
    const unsafeInputs = [
      { privileged: true },
      { hostPath: "/etc/shadow" },
      { binds: ["/var/run/docker.sock:/var/run/docker.sock"] },
      { dockerSocket: "/var/run/docker.sock" },
      { networkMode: "host" },
      { pidMode: "host" },
      { ipcMode: "host" },
      { capAdd: ["SYS_ADMIN"] },
      { devices: ["/dev/sda"] },
      { dockerEndpoint: "unix:///var/run/docker.sock" },
      { dockerFlags: ["--privileged"] },
      { command: "run", arg: "/var/run/docker.sock" },
    ];

    for (const input of unsafeInputs) {
      const violations = findUnsafeDockerInputFields(input);
      expect(violations.length).toBeGreaterThan(0);
    }

    const safeInput = {
      image: "wordpress:6-php8.3",
      port: 80,
      env: { WP_DEBUG: "false" },
    };
    expect(findUnsafeDockerInputFields(safeInput)).toHaveLength(0);
  });

  it("detects plaintext secret keys in declarative configuration (F1-012)", () => {
    const configWithSecrets = {
      databaseHost: "mariadb",
      password: "plain-password",
      apiKey: "12345",
      token: "xyz",
      nested: {
        connectionString: "postgres://user:pass@host:5432/db",
      },
    };

    const violations = findPlaintextSecretKeys(configWithSecrets);
    expect(violations).toContain("password");
    expect(violations).toContain("apiKey");
    expect(violations).toContain("token");
    expect(violations).toContain("nested.connectionString");

    const safeConfig = {
      databaseHost: "mariadb",
      port: 3306,
      tablePrefix: "wp_",
    };
    expect(findPlaintextSecretKeys(safeConfig)).toHaveLength(0);
  });

  it("redacts sensitive values cleanly", () => {
    const sensitive = {
      id: "site-1",
      name: "Acme",
      password: "secretPassword",
      apiKey: "xyz987",
      nested: {
        token: "tok123",
      },
    };

    const redacted = redactSensitiveValue(sensitive);
    expect(redacted.id).toBe("site-1");
    expect(redacted.name).toBe("Acme");
    expect(redacted.password).toBe("[REDACTED]");
    expect(redacted.apiKey).toBe("[REDACTED]");
    expect(redacted.nested.token).toBe("[REDACTED]");

    expect(redactSensitiveString("Bearer super-secret-jwt-token")).toBe("Bearer [REDACTED]");
  });
});

describe("@hosting-panel/contracts — Core DTOs & Validation", () => {
  it("validates PlatformCapabilitiesDto with truthful Phase 1 defaults & Phase 2 runtime factory", () => {
    expect(RUNTIME_BACKENDS).toEqual(["linux-systemd", "local-simulator", "disabled"]);
    expect(OPERATION_KINDS).toContain("host.security");

    expect(PlatformCapabilitiesDtoSchema.parse(DEFAULT_PLATFORM_CAPABILITIES)).toEqual(
      DEFAULT_PLATFORM_CAPABILITIES,
    );
    expect(DEFAULT_PLATFORM_CAPABILITIES.phase).toBe("phase-1");
    expect(DEFAULT_PLATFORM_CAPABILITIES.runtimeBackend).toBe("disabled");
    expect(DEFAULT_PLATFORM_CAPABILITIES.hostingMode).toBe("dedicated");
    expect(DEFAULT_PLATFORM_CAPABILITIES.sharedHostingEnabled).toBe(false);
    expect(DEFAULT_PLATFORM_CAPABILITIES.dockerExecutorRuntimeAvailable).toBe(false);
    expect(DEFAULT_PLATFORM_CAPABILITIES.hostAgentRuntimeAvailable).toBe(false);

    // Legacy payloads omitting runtimeBackend default cleanly to "disabled"
    const legacyParsed = PlatformCapabilitiesDtoSchema.parse({
      phase: "phase-1",
      hostingMode: "dedicated",
      sharedHostingEnabled: false,
      dockerExecutorRuntimeAvailable: false,
      hostAgentRuntimeAvailable: false,
      acmeTlsRuntimeAvailable: false,
      sftpAvailable: false,
      productionBackupRuntimeAvailable: false,
    });
    expect(legacyParsed.runtimeBackend).toBe("disabled");

    const disabledCaps = createPlatformCapabilities({
      runtimeBackend: "disabled",
      dockerExecutorRuntimeAvailable: true,
    });
    expect(disabledCaps).toEqual(DEFAULT_PLATFORM_CAPABILITIES);
    expect(Object.isFrozen(disabledCaps)).toBe(true);

    const p2Caps = createPlatformCapabilities({
      runtimeBackend: "linux-systemd",
      dockerExecutorRuntimeAvailable: true,
      hostAgentRuntimeAvailable: true,
    });
    for (const runtimeBackend of ["local-simulator", "disabled"] as const) {
      expect(createPlatformCapabilities({ runtimeBackend }).acmeTlsRuntimeAvailable).toBe(false);
    }
    expect(p2Caps).toEqual({
      phase: "phase-2",
      runtimeBackend: "linux-systemd",
      hostingMode: "dedicated",
      sharedHostingEnabled: false,
      dockerExecutorRuntimeAvailable: true,
      hostAgentRuntimeAvailable: true,
      acmeTlsRuntimeAvailable: true,
      sftpAvailable: false,
      productionBackupRuntimeAvailable: false,
    });
    expect(Object.isFrozen(p2Caps)).toBe(true);

    // Shared / ACME / SFTP / Backups MUST remain strictly gated false (AC-F2-10)
    expect(
      PlatformCapabilitiesDtoSchema.safeParse({
        ...p2Caps,
        sharedHostingEnabled: true,
      }).success,
    ).toBe(false);
  });

  it("validates Phase 2 EncryptedSecretMetadataDto, UpsertEncryptedSecretInput, HostDaemonHeartbeatDto & HostTelemetryDto", () => {
    const secretMeta = EncryptedSecretMetadataDtoSchema.parse({
      id: "sec_01",
      organizationId: "org_acme",
      siteId: "site_shop",
      secretKey: "WORDPRESS_DB_PASSWORD",
      keyVersion: "v1",
      version: 2,
      createdByUserId: "usr_elena",
      createdAt: SAMPLE_TIMESTAMP,
      updatedAt: SAMPLE_TIMESTAMP,
    });
    expect(findForbiddenPublicDtoKeys(secretMeta)).toHaveLength(0);

    expect(
      UpsertEncryptedSecretInputSchema.parse({
        secretKey: "WORDPRESS_DB_PASSWORD",
        value: "s3cr3t-pass!",
        siteId: null,
      }),
    ).toBeTruthy();

    expect(
      UpsertEncryptedSecretInputSchema.safeParse({
        secretKey: "123_INVALID_START",
        value: "abc",
      }).success,
    ).toBe(false);

    expect(
      HostDaemonHeartbeatDtoSchema.parse({
        hostId: "hst_ded_01",
        component: "docker_executor",
        status: "online",
        version: "0.2.0",
        lastSeenAt: SAMPLE_TIMESTAMP,
        telemetrySnapshot: { activeContainers: 3 },
      }),
    ).toBeTruthy();

    expect(
      HostTelemetryDtoSchema.parse({
        hostId: "hst_ded_01",
        cpuUsagePercent: 18.5,
        memoryUsedBytes: "4294967296",
        memoryTotalBytes: "17179869184",
        storageUsedBytes: "21474836480",
        storageTotalBytes: "107374182400",
        uptimeSeconds: 86400,
        kernelVersion: "6.8.0-45-generic",
        dockerEngineReachable: true,
        collectedAt: SAMPLE_TIMESTAMP,
      }),
    ).toBeTruthy();
  });

  it("validates HostDto & Allocation DTOs", () => {
    const host = {
      id: "hst_ded_01",
      name: "Acme Dedicated VPS",
      hostname: "hst-acme.internal",
      ipv4Address: "192.168.1.100",
      ipv6Address: null,
      status: "ready" as const,
      hostingMode: "dedicated" as const,
      totalCpuMilli: 8000,
      totalMemoryBytes: "17179869184",
      totalStorageBytes: "107374182400",
      securityReviewed: true,
      sharedApproved: false,
      metadata: {},
      createdAt: SAMPLE_TIMESTAMP,
      updatedAt: SAMPLE_TIMESTAMP,
    };
    expect(HostDtoSchema.parse(host)).toEqual(host);

    const alloc = {
      id: "alloc_01",
      hostId: "hst_ded_01",
      organizationId: "org_acme",
      status: "active" as const,
      hostingMode: "dedicated" as const,
      dedicatedScope: true,
      createdAt: SAMPLE_TIMESTAMP,
      updatedAt: SAMPLE_TIMESTAMP,
    };
    expect(HostAllocationDtoSchema.parse(alloc)).toEqual(alloc);
  });

  it("validates ServiceTemplateDto & SiteDetailDto", () => {
    const tpl = {
      id: "tpl_wp",
      name: "WordPress",
      slug: "wordpress",
      description: "WordPress 6.4 + PHP 8.3",
      category: "cms",
      defaultImage: "wordpress:6.4-php8.3",
      defaultPort: 80,
      environmentSchema: {},
      defaultConfiguration: {},
      approvedForDedicated: true,
      approvedForShared: false,
      minCpuMilli: 500,
      minMemoryBytes: "536870912",
      createdAt: SAMPLE_TIMESTAMP,
      updatedAt: SAMPLE_TIMESTAMP,
    };
    expect(ServiceTemplateDtoSchema.parse(tpl)).toEqual(tpl);

    const siteDetail = {
      id: "site_shop",
      organizationId: "org_acme",
      hostAllocationId: "alloc_01",
      name: "Shop",
      slug: "shop",
      status: "ready" as const,
      createdAt: SAMPLE_TIMESTAMP,
      updatedAt: SAMPLE_TIMESTAMP,
      services: [
        {
          id: "svc_wp",
          siteId: "site_shop",
          organizationId: "org_acme",
          serviceTemplateId: "tpl_wp",
          name: "WordPress",
          desiredStatus: "running" as const,
          currentRevisionId: "rev_01",
          createdAt: SAMPLE_TIMESTAMP,
          updatedAt: SAMPLE_TIMESTAMP,
        },
      ],
      domains: [
        {
          id: "dom_01",
          siteId: "site_shop",
          organizationId: "org_acme",
          hostname: "negozio.acme.it",
          isPrimary: true,
          status: "active" as const,
          createdAt: SAMPLE_TIMESTAMP,
          updatedAt: SAMPLE_TIMESTAMP,
        },
      ],
      phpVersion: null,
      driftSummary: {
        totalServices: 1,
        inSyncCount: 1,
        driftedCount: 0,
        unknownCount: 0,
        overallDriftStatus: "in_sync" as const,
      },
    };
    expect(SiteDetailDtoSchema.parse(siteDetail)).toEqual(siteDetail);
  });
});
