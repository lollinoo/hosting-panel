import { describe, expect, it } from "vitest";
import {
  Phase1DisabledDockerExecutor,
  createApprovedServiceSpec,
} from "../src/index.js";

describe("@hosting-panel/executor-contracts — ApprovedServiceSpec Factory", () => {
  it("creates compliant immutable ApprovedServiceSpec", () => {
    const spec = createApprovedServiceSpec({
      serviceInstanceId: "svc-1",
      siteId: "site-1",
      organizationId: "org-1",
      image: "wordpress:6.4-php8.3",
      containerName: "wp-app-01",
      env: { WP_DEBUG: "false" },
      portBindings: [{ containerPort: 80, hostPort: 8080 }],
      resourceLimits: { cpuMilli: 500, memoryBytes: "536870912" },
    });

    expect(spec.__brand).toBe("ApprovedServiceSpec");
    expect(spec.image).toBe("wordpress:6.4-php8.3");
    expect(Object.isFrozen(spec)).toBe(true);
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

  it("strictly throws if plaintext secrets are present (F1-012)", () => {
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
