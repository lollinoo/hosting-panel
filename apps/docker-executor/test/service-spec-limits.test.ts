import { DEFAULT_PHPMYADMIN_PORT, DEFAULT_SFTP_PORT } from "@hosting-panel/contracts";
import { createApprovedServiceSpec, type ApprovedServiceSpec } from "@hosting-panel/executor-contracts";
import { describe, expect, it } from "vitest";
import {
  buildHardenedContainerCreatePayload,
  buildIngressProxyContainerPayload,
  buildPhpMyAdminContainerPayload,
  buildSftpContainerPayload,
  validateExecutorServiceSpec,
} from "../src/index.js";

const spec = (over: Partial<Parameters<typeof createApprovedServiceSpec>[0]> = {}): ApprovedServiceSpec =>
  createApprovedServiceSpec({
    serviceInstanceId: "svc_lim",
    siteId: "site_lim",
    organizationId: "org_lim",
    image: "ghcr.io/example/webapp:1.0.0",
    containerName: "hp-site-lim",
    revisionNumber: 1,
    specHash: "hash_lim",
    ...over,
  });

const GIB = 1024 ** 3;

describe("service resource ceiling (exec.1)", () => {
  it("refuses memory above 64 GiB and CPU above 64000 milli", () => {
    for (const resourceLimits of [
      { cpuMilli: 1000, memoryBytes: String(64 * GIB + 1) },
      { cpuMilli: 64_001, memoryBytes: "536870912" },
    ]) {
      expect(() => validateExecutorServiceSpec(spec({ resourceLimits }))).toThrowError(
        expect.objectContaining({ code: "VALIDATION_ERROR" }),
      );
    }
  });

  it("passes a spec at the ceiling and a WordPress-sized one unchanged", () => {
    for (const resourceLimits of [
      { cpuMilli: 64_000, memoryBytes: String(64 * GIB) },
      { cpuMilli: 1000, memoryBytes: "536870912" },
    ]) {
      const input = spec({ resourceLimits });
      // The validation stamps the spec again, so the time of approval may be a millisecond later.
      expect(validateExecutorServiceSpec(input)).toEqual({ ...input, approvedAt: expect.any(String) });
    }
  });
});

describe("reserved host ports (exec.2) and loopback publish (exec.4a)", () => {
  const reserved = [22, 80, 443, DEFAULT_SFTP_PORT, 3000, 4000, 5432, DEFAULT_PHPMYADMIN_PORT];

  it("refuses every port the server itself uses", () => {
    for (const hostPort of reserved) {
      expect(() =>
        validateExecutorServiceSpec(spec({ portBindings: [{ containerPort: 80, hostPort }] })),
      ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    }
  });

  it("publishes another port on 127.0.0.1 only", () => {
    const payload = buildHardenedContainerCreatePayload(
      spec({ portBindings: [{ containerPort: 80, hostPort: 8080 }] }),
    );
    expect(payload.HostConfig.PortBindings).toEqual({ "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "8080" }] });
  });

  it("the shared SFTP server, phpMyAdmin and the proxy still publish their own ports", () => {
    const sftp = buildSftpContainerPayload({ stateDir: "/srv/hp-test/sftp", sites: [] }).payload;
    expect(sftp.HostConfig.PortBindings["2222/tcp"]?.[0]?.HostPort).toBe(String(DEFAULT_SFTP_PORT));
    const pma = buildPhpMyAdminContainerPayload({
      containerName: "hp_phpmyadmin",
      network: "hp_phpmyadmin_net",
      configFile: "/srv/hp-test/phpmyadmin/config.inc.php",
      port: DEFAULT_PHPMYADMIN_PORT,
    }).payload;
    expect(JSON.stringify(pma.HostConfig)).toContain(`"HostPort":"${String(DEFAULT_PHPMYADMIN_PORT)}"`);
    const proxy = buildIngressProxyContainerPayload({
      staticConfigHostPath: "/srv/hp-test/ingress/traefik.yml",
      dynamicDirHostPath: "/srv/hp-test/ingress/dynamic",
      acmeDirHostPath: "/srv/hp-test/ingress/acme",
    });
    expect(JSON.stringify(proxy.HostConfig.PortBindings)).toMatch(/"HostPort":"80".*"HostPort":"443"/);
  });
});
