import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  ERROR_CODES,
  ERROR_CODE_HTTP_STATUS,
  OPERATION_KINDS,
  PRESET_ROLE_PERMISSIONS,
  RUNTIME_BACKENDS,
  createPlatformCapabilities,
  type ErrorCode,
} from "@hosting-panel/contracts";
import {
  and,
  createDatabaseClient,
  domains,
  eq,
  hostAllocations,
  moveSiteToOrganizationTransactional,
  organizations,
  permissions,
  rolePermissions,
  roles,
  tlsCertificateVersions,
  tlsCertificates,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SUPPORT_ACCESS_PERMISSIONS } from "../src/auth/support-access.service.js";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { ApiExceptionFilter } from "../src/common/api-exception.filter.js";
import { ControlPlaneError } from "../src/common/control-plane.error.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { skipPasswordChange } from "./fixtures/password-change.js";

const KEY = Buffer.alloc(32, 7);
const PW = "correct horse battery";
const SETUP = { installationName: "Test", hostHostname: "panel.test", hostIpv4: "10.0.0.1" };
const SITE = {
  name: "Hotel Bella",
  domain: "hotel.it",
  title: "Hotel Bella Vista",
  adminUser: "admin",
  adminEmail: "admin@hotel.it",
  adminPassword: "canary-Pass-123456",
  includeWww: true,
};
const NEW_ERROR_CODES = [
  "CERTIFICATE_INVALID",
  "CERTIFICATE_KEY_MISMATCH",
  "CERTIFICATE_CHAIN_INVALID",
  "CERTIFICATE_NOT_YET_VALID",
  "CERTIFICATE_EXPIRED",
  "CERTIFICATE_HOSTNAME_MISMATCH",
  "CERTIFICATE_IN_USE",
  "CERTIFICATE_APPLY_FAILED",
  "CERTIFICATE_SNI_MISMATCH",
  "CERTIFICATE_UPLOAD_TOO_LARGE",
  "CERTIFICATE_FORMAT_UNSUPPORTED",
  "BACKUP_TARGET_IN_USE",
] as const satisfies readonly ErrorCode[];
const CAPABILITY_FLAGS = [
  "manualTlsCertificatesAvailable",
  "localBackupTargetsAvailable",
  "encryptedBackupExportAvailable",
] as const;
const PEM = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nSECRETBODY\n-----END PRIVATE KEY-----";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Runs the real exception filter on an error and returns what it would send. */
function filtered(error: unknown) {
  let status = 0;
  let body: Json = {};
  const reply = {
    sent: false,
    raw: { headersSent: false },
    header: () => reply,
    status: (s: number) => {
      status = s;
      return reply;
    },
    send: (b: Json) => {
      body = b;
    },
  };
  new ApiExceptionFilter().catch(error, {
    switchToHttp: () => ({
      getRequest: () => ({ url: "/x", raw: { url: "/x" }, headers: { "x-request-id": "req-m1" } }),
      getResponse: () => reply,
    }),
  } as never);
  return { status, body };
}

describe("HCP-SPEC-004 M1 — error codes through the exception filter", () => {
  it("each of the 12 new codes is a real ERROR_CODE and answers its pinned HTTP status", () => {
    const pinned: Record<(typeof NEW_ERROR_CODES)[number], number> = {
      CERTIFICATE_INVALID: 422,
      CERTIFICATE_KEY_MISMATCH: 422,
      CERTIFICATE_CHAIN_INVALID: 422,
      CERTIFICATE_NOT_YET_VALID: 422,
      CERTIFICATE_EXPIRED: 422,
      CERTIFICATE_HOSTNAME_MISMATCH: 422,
      CERTIFICATE_IN_USE: 409,
      CERTIFICATE_APPLY_FAILED: 502,
      CERTIFICATE_SNI_MISMATCH: 409,
      CERTIFICATE_UPLOAD_TOO_LARGE: 413,
      CERTIFICATE_FORMAT_UNSUPPORTED: 422,
      BACKUP_TARGET_IN_USE: 409,
    };
    expect(Object.keys(pinned).sort()).toEqual([...NEW_ERROR_CODES].sort());
    for (const code of NEW_ERROR_CODES) {
      expect(ERROR_CODES).toContain(code);
      const { status, body } = filtered(new ControlPlaneError(code, `message of ${code}`));
      expect(status, code).toBe(pinned[code]);
      expect(body.error.code).toBe(code);
      expect(body.error.message).toBe(`message of ${code}`);
    }
  });

  it("a bare error carrying a new code is mapped too (the non-ControlPlaneError branch)", () => {
    const { status, body } = filtered(Object.assign(new Error("too big"), { code: "CERTIFICATE_UPLOAD_TOO_LARGE" }));
    expect(status).toBe(413);
    expect(body.error.code).toBe("CERTIFICATE_UPLOAD_TOO_LARGE");
  });

  it("the filter and the contract map agree for every code", () => {
    for (const code of ERROR_CODES) {
      expect(filtered(new ControlPlaneError(code, "x")).status, code).toBe(ERROR_CODE_HTTP_STATUS[code]);
    }
  });

  it("a PEM block in the message, in a detail or in a bare error message is replaced by [REDACTED_PEM]", () => {
    const viaControlPlane = filtered(
      new ControlPlaneError("CERTIFICATE_INVALID", `bad input ${PEM} tail`, {
        details: [{ field: "keyPem", message: `see ${PEM}`, reason: PEM }],
      }),
    );
    const viaBare = filtered(Object.assign(new Error(`oops ${PEM}`), { code: "CERTIFICATE_KEY_MISMATCH" }));
    for (const { body } of [viaControlPlane, viaBare]) {
      const raw = JSON.stringify(body);
      expect(raw).toContain("[REDACTED_PEM]");
      expect(raw).not.toContain("SECRETBODY");
      expect(raw).not.toContain("BEGIN PRIVATE KEY");
      expect(raw).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC");
    }
    expect(viaControlPlane.body.error.message).toBe("bad input [REDACTED_PEM] tail");
    expect(viaControlPlane.body.error.details[0]).toEqual({
      field: "keyPem",
      message: "see [REDACTED_PEM]",
      reason: "[REDACTED_PEM]",
    });
  });

  it("a truncated PEM (no END line) is redacted up to the end of the message", () => {
    const { body } = filtered(new ControlPlaneError("CERTIFICATE_INVALID", "cut -----BEGIN CERTIFICATE-----\nMIIBabc"));
    expect(body.error.message).toBe("cut [REDACTED_PEM]");
  });
});

describe("HCP-SPEC-004 M1 — capability flags", () => {
  it("manual TLS and local targets are on only for linux-systemd; encrypted export is false everywhere", () => {
    for (const runtimeBackend of RUNTIME_BACKENDS) {
      const caps = createPlatformCapabilities({ runtimeBackend });
      for (const flag of CAPABILITY_FLAGS) {
        const expected =
          (flag === "manualTlsCertificatesAvailable" || flag === "localBackupTargetsAvailable") && runtimeBackend === "linux-systemd";
        expect(caps[flag], `${runtimeBackend}.${flag}`).toBe(expected);
      }
    }
  });
});

describe("HCP-SPEC-004 M1 — permissions, openapi, operation kind", () => {
  it("site.certificates.manage is a support-access key (15 keys) and sits before service.deploy", () => {
    expect(SUPPORT_ACCESS_PERMISSIONS).toHaveLength(15);
    expect(SUPPORT_ACCESS_PERMISSIONS).toContain("site.certificates.manage");
    expect(new Set(SUPPORT_ACCESS_PERMISSIONS).size).toBe(15);
  });

  it("the preset map grants it to customer_owner and hosting_admin only", () => {
    const holders = Object.entries(PRESET_ROLE_PERMISSIONS)
      .filter(([, keys]) => keys.includes("site.certificates.manage"))
      .map(([role]) => role)
      .sort();
    expect(holders).toEqual(["customer_owner", "hosting_admin"]);
  });

  const openapi = readFileSync(new URL("../../../docs/api/openapi.yaml", import.meta.url), "utf8");

  it("openapi.yaml lists all 12 new error codes once in the ErrorCode enum", () => {
    for (const code of NEW_ERROR_CODES) {
      expect(openapi.split("\n").filter((l) => l.trim() === `- ${code}`), code).toHaveLength(1);
    }
  });

  it("openapi.yaml lists every ERROR_CODE and the site.tls.apply operation kind", () => {
    for (const code of ERROR_CODES) expect(openapi, code).toMatch(new RegExp(`^\\s+- ${code}$`, "m"));
    expect(OPERATION_KINDS).toContain("site.tls.apply");
    for (const kind of OPERATION_KINDS) expect(openapi, kind).toMatch(new RegExp(`^\\s+- ${kind.replace(/\./g, "\\.")}$`, "m"));
    expect(openapi).toMatch(/enum: \[[^\]]*\bsite\.tls\.apply\b[^\]]*\]/);
  });
});

describe("HCP-SPEC-004 M1 — API behaviour", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let token: string;
  let adminToken: string;
  let orgId: string;
  let siteId: string;

  async function login(email: string, password: string, totpSecret?: string): Promise<string> {
    const res = await fetch(`${app.baseUrl!}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        ...(totpSecret ? { totpCode: totpCodeAt(totpSecret, Math.floor(Date.now() / 30_000)) } : {}),
      }),
    });
    return ((await res.json()) as Json).data.accessToken as string;
  }

  async function call(method: string, path: string, body?: unknown, as: string = token) {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: { Authorization: `Bearer ${as}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, raw, body: raw ? (JSON.parse(raw) as Json) : {} };
  }

  /** Moves the site to a second organisation on the same host, as the managed-sites tests do. */
  async function moveSiteToOtherOrganization(): Promise<string> {
    const [mine] = await dbClient.db.select().from(organizations).where(eq(organizations.id, orgId));
    const [alloc] = await dbClient.db.select().from(hostAllocations).where(eq(hostAllocations.organizationId, orgId));
    const toOrganizationId = `org_${randomUUID()}`;
    const toHostAllocationId = `alloc_${randomUUID()}`;
    await dbClient.db
      .insert(organizations)
      .values({ id: toOrganizationId, platformInstallationId: mine!.platformInstallationId, name: "Bar Sport", slug: "bar-sport" });
    await dbClient.db
      .insert(hostAllocations)
      .values({ id: toHostAllocationId, hostId: alloc!.hostId, organizationId: toOrganizationId, status: "active" });
    await moveSiteToOrganizationTransactional(dbClient.db, {
      siteId,
      fromOrganizationId: orgId,
      toOrganizationId,
      toHostAllocationId,
      masterKey: KEY.toString("hex"),
    });
    return toOrganizationId;
  }

  /** An imported certificate with one version for the given organisation; returns the ids. */
  async function importVersion(organizationId: string, forSite: string | null) {
    const certificateId = `cti_${randomUUID().replace(/-/g, "")}`;
    const versionId = `ctv_${randomUUID().replace(/-/g, "")}`;
    await dbClient.db.insert(tlsCertificates).values({ id: certificateId, organizationId, name: "hotel", createdForSiteId: forSite });
    await dbClient.db.insert(tlsCertificateVersions).values({
      id: versionId,
      certificateId,
      organizationId,
      versionNumber: 1,
      leafPem: "-----BEGIN CERTIFICATE-----\nLEAF-BODY-NOT-FOR-DTOS\n-----END CERTIFICATE-----",
      chainPem: "",
      keyCiphertextBase64: "KEY-CIPHERTEXT-MARKER",
      keyIvBase64: "i",
      keyAuthTagBase64: "t",
      subject: "CN=www.hotel.it",
      issuer: "CN=CA",
      serialNumber: "01",
      fingerprintSha256: randomUUID().replace(/-/g, "").repeat(2),
      notBefore: new Date(Date.now() - 86_400_000),
      notAfter: new Date(Date.now() + 30 * 86_400_000),
      sanDns: ["www.hotel.it"],
      keyType: "ec",
      keyBits: 256,
      status: "active",
    });
    return { certificateId, versionId };
  }

  beforeEach(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin@x.it", name: "Admin", password: PW });
    app = await createControlPlaneApp({
      dnsLookup: { lookup: async () => ({ a: [], aaaa: [] }) },
      domainReconcileIntervalMs: null,
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      runtimeBackend: "local-simulator",
      dockerExecutor: new InMemoryDockerSimulatorAdapter(),
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      recoverUnknownOnStart: false,
    });
    adminToken = await login("admin@x.it", PW, admin.totpSecretBase32);
    const created = await call(
      "POST",
      "/v1/admin/customer-account",
      { organizationName: "Hotel Mario", ownerEmail: "mario@hotel.it", ownerName: "Mario" },
      adminToken,
    );
    expect(created.status, created.raw).toBe(201);
    await skipPasswordChange(dbClient.db, "mario@hotel.it");
    orgId = created.body.data.organizationId as string;
    token = await login("mario@hotel.it", created.body.data.temporaryPassword as string);
    const site = await call("POST", `/v1/organizations/${orgId}/managed-sites`, SITE);
    expect(site.status).toBe(202);
    siteId = site.body.data.siteId as string;
  });

  afterEach(async () => {
    await app.close();
    await dbClient.close();
  });

  it("the three capability flags are false in /v1/me, org detail, /capabilities and for the admin", async () => {
    const me = await call("GET", "/v1/me");
    const adminMe = await call("GET", "/v1/me", undefined, adminToken);
    const caps = await call("GET", `/v1/organizations/${orgId}/capabilities`);
    const org = await call("GET", `/v1/organizations/${orgId}`);
    const sets: Json[] = [me.body.data.platformCapabilities ?? me.body.data.capabilities, adminMe.body.data.platformCapabilities ?? adminMe.body.data.capabilities, caps.body.data, org.body.data.capabilities];
    for (const res of [me, adminMe, caps, org]) expect(res.status).toBe(200);
    for (const set of sets) {
      expect(set).toBeDefined();
      for (const flag of CAPABILITY_FLAGS) expect(set[flag], flag).toBe(false);
    }
  });

  it("site.certificates.manage is seeded in the database for customer_owner and hosting_admin only", async () => {
    const granted = await dbClient.db
      .select({ role: roles.name })
      .from(rolePermissions)
      .innerJoin(roles, eq(roles.id, rolePermissions.roleId))
      .where(eq(rolePermissions.permissionKey, "site.certificates.manage"));
    expect(granted.map((r) => r.role).sort()).toEqual(["customer_owner", "hosting_admin"]);
    const key = await dbClient.db.select().from(permissions).where(eq(permissions.key, "site.certificates.manage"));
    expect(key).toHaveLength(1);
    // The collaborator does not hold it.
    const collab = await dbClient.db
      .select()
      .from(rolePermissions)
      .innerJoin(roles, eq(roles.id, rolePermissions.roleId))
      .where(and(eq(roles.name, "customer_collaborator"), eq(rolePermissions.permissionKey, "site.certificates.manage")));
    expect(collab).toHaveLength(0);
  });

  it("the domain DTO of an acme row has the exact five tls keys with null values, on both routes", async () => {
    for (const res of [
      await call("GET", `/v1/organizations/${orgId}/managed-sites/${siteId}/domains`),
      await call("GET", `/v1/admin/sites/${siteId}/domains`, undefined, adminToken),
    ]) {
      expect(res.status).toBe(200);
      for (const d of res.body.data.domains as Json[]) {
        expect(Object.keys(d.tls).sort()).toEqual(["certificateId", "mode", "problem", "state", "versionId"]);
        expect(d.tls.mode).toBe("acme");
        expect(d.tls.certificateId).toBeNull();
        expect(d.tls.versionId).toBeNull();
      }
    }
  });

  it("a manual row exposes ids only: no PEM, ciphertext or key field anywhere in either body", async () => {
    const { certificateId, versionId } = await importVersion(orgId, siteId);
    await dbClient.db
      .update(domains)
      .set({ certMode: "manual", manualCertificateVersionId: versionId, certStatus: "active" })
      .where(eq(domains.hostname, "www.hotel.it"));
    const forbiddenKey = /pem|ciphertext|keyIv|keyAuthTag|privateKey|chain|leaf/i;
    const keysOf = (v: unknown): string[] =>
      v !== null && typeof v === "object"
        ? Object.entries(v as Json).flatMap(([k, x]) => [k, ...keysOf(x)])
        : [];
    for (const res of [
      await call("GET", `/v1/organizations/${orgId}/managed-sites/${siteId}/domains`),
      await call("GET", `/v1/admin/sites/${siteId}/domains`, undefined, adminToken),
    ]) {
      expect(res.status).toBe(200);
      const manual = (res.body.data.domains as Json[]).find((d) => d.hostname === "www.hotel.it")!;
      expect(manual.tls).toEqual({ mode: "manual", certificateId, versionId, state: "active", problem: null });
      expect(keysOf(res.body).filter((k) => forbiddenKey.test(k))).toEqual([]);
      expect(res.raw).not.toContain("LEAF-BODY-NOT-FOR-DTOS");
      expect(res.raw).not.toContain("KEY-CIPHERTEXT-MARKER");
      expect(res.raw).not.toContain("-----BEGIN");
      const auto = (res.body.data.domains as Json[]).find((d) => d.hostname === "hotel.it")!;
      expect(auto.tls.mode).toBe("acme");
    }
  });

  it("once the site belongs to another organisation its domains and detail answer 404 to the former owner, and the admin still sees them", async () => {
    const otherOrgId = await moveSiteToOtherOrganization();

    const stale = await call("GET", `/v1/organizations/${orgId}/managed-sites/${siteId}/domains`);
    expect(stale.status).toBe(404);
    expect(stale.body.error.code).toBe("NOT_FOUND");
    expect(stale.raw).not.toContain("hotel.it");
    expect((await call("GET", `/v1/organizations/${orgId}/managed-sites/${siteId}`)).status).toBe(404);

    // The site id under the wrong organisation path is no oracle for the other tenant either.
    const wrongPath = await call("GET", `/v1/organizations/${otherOrgId}/managed-sites/${siteId}/domains`);
    expect([403, 404]).toContain(wrongPath.status);
    expect(wrongPath.raw).not.toContain("www.hotel.it");

    const admin = await call("GET", `/v1/admin/sites/${siteId}/domains`, undefined, adminToken);
    expect(admin.status).toBe(200);
    expect((admin.body.data.domains as Json[]).every((d) => d.tls.mode === "acme")).toBe(true);
  });

  it("an unknown site answers 404 on the customer and the admin route", async () => {
    expect((await call("GET", `/v1/organizations/${orgId}/managed-sites/site_does_not_exist/domains`)).status).toBe(404);
    expect((await call("GET", `/v1/admin/sites/site_does_not_exist/domains`, undefined, adminToken)).status).toBe(404);
  });
});
