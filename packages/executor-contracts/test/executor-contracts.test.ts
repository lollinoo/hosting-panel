import { describe, expect, it } from "vitest";
import {
  DeployServiceIpcRequestSchema,
  ExecutorHealthResponseSchema,
  ObservedServiceStateWireSchema,
  Phase1DisabledDockerExecutor,
  ServiceInstanceActionIpcRequestSchema,
  createApprovedServiceSpec,
} from "../src/index.js";

describe("@hosting-panel/executor-contracts — ApprovedServiceSpec Factory (AC-F1-04 & AC-F2-03)", () => {
  it("creates compliant immutable ApprovedServiceSpec with Phase 2 extensions", () => {
    const spec = createApprovedServiceSpec({
      serviceInstanceId: "svc-1",
      siteId: "site-1",
      organizationId: "org-1",
      image: "wordpress:6.4-php8.3",
      containerName: "wp-app-01",
      env: { WP_DEBUG: "false" },
      portBindings: [{ containerPort: 80, hostPort: 8080 }],
      resourceLimits: { cpuMilli: 500, memoryBytes: "536870912" },
      revisionNumber: 2,
      specHash: "a".repeat(64),
      domains: ["negozio.acme.it"],
      exposeHttp: true,
      internalPort: 80,
      pidsLimit: 256,
      volumeMounts: [
        { volumeSuffix: "wp_content", containerPath: "/var/www/html", readOnly: false },
      ],
      resolvedSecrets: {
        WORDPRESS_DB_PASSWORD: "decrypted-ephemeral-secret",
      },
    });

    expect(spec.__brand).toBe("ApprovedServiceSpec");
    expect(spec.image).toBe("wordpress:6.4-php8.3");
    expect(spec.revisionNumber).toBe(2);
    expect(spec.pidsLimit).toBe(256);
    expect(spec.volumeMounts).toEqual([
      { volumeSuffix: "wp_content", containerPath: "/var/www/html", readOnly: false },
    ]);
    expect(spec.resolvedSecrets).toEqual({
      WORDPRESS_DB_PASSWORD: "decrypted-ephemeral-secret",
    });
    expect(Object.isFrozen(spec)).toBe(true);
    expect(Object.isFrozen(spec.volumeMounts!)).toBe(true);
    expect(Object.isFrozen(spec.resolvedSecrets!)).toBe(true);
  });

  it("strictly throws if unsafe Docker fields are present (AC-F1-04)", () => {
    expect(() =>
      createApprovedServiceSpec({
        serviceInstanceId: "svc-1",
        siteId: "site-1",
        organizationId: "org-1",
        image: "wordpress:6.4",
        containerName: "wp-app",
        rawConfig: {
          privileged: true,
        },
      }),
    ).toThrow(/unsafe Docker attributes detected/);

    expect(() =>
      createApprovedServiceSpec({
        serviceInstanceId: "svc-1",
        siteId: "site-1",
        organizationId: "org-1",
        image: "wordpress:6.4",
        containerName: "wp-app",
        rawConfig: {
          binds: ["/var/run/docker.sock:/var/run/docker.sock"],
        },
      }),
    ).toThrow(/unsafe Docker attributes detected/);
  });

  it("strictly throws if plaintext secrets are present in rawConfig or env even when resolvedSecrets is supported (F1-012)", () => {
    expect(() =>
      createApprovedServiceSpec({
        serviceInstanceId: "svc-1",
        siteId: "site-1",
        organizationId: "org-1",
        image: "mariadb:11",
        containerName: "db-app",
        rawConfig: {
          password: "my-plain-password",
        },
      }),
    ).toThrow(/plaintext secrets detected/);

    expect(() =>
      createApprovedServiceSpec({
        serviceInstanceId: "svc-1",
        siteId: "site-1",
        organizationId: "org-1",
        image: "mariadb:11",
        containerName: "db-app",
        env: {
          password: "my-plain-password",
        },
      }),
    ).toThrow(/plaintext secrets detected/);
  });

  it("rejects forbidden container mount paths, path traversal, invalid volumeSuffix, and out-of-range pidsLimit with HOST_POLICY_DENIED (AC-F2-03)", () => {
    const forbiddenPaths = [
      "/",
      "///",
      "/etc",
      "/etc/passwd",
      "/var/run",
      "/var/run/docker.sock",
      "/proc",
      "/proc/1/environ",
      "/sys",
      "/root",
      "/root/.ssh",
      "/boot",
      "/dev",
      "/dev/mem",
      "/var/www/../etc/shadow",
      "relative/path",
    ];

    for (const containerPath of forbiddenPaths) {
      expect(() =>
        createApprovedServiceSpec({
          serviceInstanceId: "svc-1",
          siteId: "site-1",
          organizationId: "org-1",
          image: "nginx:1.27-alpine",
          containerName: "web-01",
          volumeMounts: [{ volumeSuffix: "data", containerPath }],
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "HOST_POLICY_DENIED",
        }),
      );
    }

    // Invalid volumeSuffix
    expect(() =>
      createApprovedServiceSpec({
        serviceInstanceId: "svc-1",
        siteId: "site-1",
        organizationId: "org-1",
        image: "nginx:1.27-alpine",
        containerName: "web-01",
        volumeMounts: [{ volumeSuffix: "../escape", containerPath: "/data" }],
      }),
    ).toThrowError(expect.objectContaining({ code: "HOST_POLICY_DENIED" }));

    // Out-of-range pidsLimit
    for (const badPids of [0, 15, 4097, -1]) {
      expect(() =>
        createApprovedServiceSpec({
          serviceInstanceId: "svc-1",
          siteId: "site-1",
          organizationId: "org-1",
          image: "nginx:1.27-alpine",
          containerName: "web-01",
          pidsLimit: badPids,
        }),
      ).toThrowError(expect.objectContaining({ code: "HOST_POLICY_DENIED" }));
    }

    // Invalid resolvedSecrets env key
    expect(() =>
      createApprovedServiceSpec({
        serviceInstanceId: "svc-1",
        siteId: "site-1",
        organizationId: "org-1",
        image: "nginx:1.27-alpine",
        containerName: "web-01",
        resolvedSecrets: { "../BAD_KEY": "secret" },
      }),
    ).toThrowError(expect.objectContaining({ code: "HOST_POLICY_DENIED" }));
  });

  it("validates IPC Zod schemas for Docker Executor", () => {
    const parsedDeploy = DeployServiceIpcRequestSchema.parse({
      operationId: "op_01",
      spec: {
        serviceInstanceId: "svc_01",
        siteId: "site_01",
        organizationId: "org_01",
        image: "wordpress:6.4-php8.3",
        containerName: "hp_svc_01",
        pidsLimit: 256,
        volumeMounts: [{ volumeSuffix: "wp_data", containerPath: "/var/www/html" }],
        resolvedSecrets: { WORDPRESS_DB_PASSWORD: "secret" },
      },
    });
    expect(parsedDeploy.spec.pidsLimit).toBe(256);

    // Unsafe mount rejected at Zod wire boundary too
    expect(
      DeployServiceIpcRequestSchema.safeParse({
        spec: {
          serviceInstanceId: "svc_01",
          siteId: "site_01",
          organizationId: "org_01",
          image: "wordpress:6.4",
          containerName: "hp_svc_01",
          volumeMounts: [{ volumeSuffix: "sock", containerPath: "/var/run/docker.sock" }],
        },
      }).success,
    ).toBe(false);

    expect(
      ServiceInstanceActionIpcRequestSchema.parse({
        operationId: "op_02",
        serviceInstanceId: "svc_01",
        action: "restart",
      }).action,
    ).toBe("restart");

    expect(
      ObservedServiceStateWireSchema.parse({
        serviceInstanceId: "svc_01",
        observedStatus: "running",
        observedRevisionHash: "b".repeat(64),
        outOfBandModified: false,
        observedAt: "2026-11-07T12:00:00.000Z",
        restartCount: 0,
      }).restartCount,
    ).toBe(0);

    expect(
      ExecutorHealthResponseSchema.parse({
        component: "docker_executor",
        status: "online",
        version: "0.2.0",
        runtimeBackend: "local-simulator",
        dockerEngineReachable: true,
        checkedAt: "2026-11-07T12:00:00.000Z",
      }).status,
    ).toBe("online");
  });
});

describe("@hosting-panel/executor-contracts — Phase1DisabledDockerExecutor", () => {
  it("enforces Phase 1 disabled runtime (NOT_SUPPORTED)", async () => {
    const executor = new Phase1DisabledDockerExecutor();
    expect(executor.isRuntimeAvailable).toBe(false);

    const spec = createApprovedServiceSpec({
      serviceInstanceId: "svc-1",
      siteId: "site-1",
      organizationId: "org-1",
      image: "wordpress:6.4",
      containerName: "wp-app",
    });

    await expect(executor.deployService(spec)).rejects.toThrow(/disabled in Phase 1/);
    await expect(executor.restartService("svc-1")).rejects.toThrow(/disabled in Phase 1/);
    await expect(executor.stopService("svc-1")).rejects.toThrow(/disabled in Phase 1/);
    await expect(executor.deleteService("svc-1")).rejects.toThrow(/disabled in Phase 1/);

    const observed = await executor.getObservedState("svc-1");
    expect(observed).toBeNull();
  });
});

describe("Phase1DisabledDockerExecutor site capabilities", () => {
  it("phase1 executor refuses site jobs, purge and logs with NOT_SUPPORTED", async () => {
    const executor = new Phase1DisabledDockerExecutor();
    const job = { jobId: "job_1", kind: "db.drop" as const, siteId: "s", organizationId: "o", params: {} };
    await expect(executor.runSiteJob(job)).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    await expect(executor.purgeSite("s")).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    await expect(executor.getServiceLogs("svc", 10)).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
  });
});
