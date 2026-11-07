import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  findForbiddenPublicDtoKeys,
  ApiErrorEnvelopeSchema,
  createErrorEnvelope,
} from "@hosting-panel/contracts";
import { decryptSession, SESSION_COOKIE_NAME } from "../src/lib/session";
import { GET as getSession } from "../src/app/api/session/route";
import { POST as postLogin } from "../src/app/api/session/login/route";
import { POST as postLogout } from "../src/app/api/session/logout/route";
import { POST as postSwitchContext } from "../src/app/api/session/switch-context/route";
import { PATCH as patchHostMode } from "../src/app/api/bff/hosts/[hostId]/mode/route";
import { POST as postHostMaintenance } from "../src/app/api/bff/hosts/[hostId]/maintenance/route";
import { POST as postHostAllocations } from "../src/app/api/bff/hosts/[hostId]/allocations/route";
import { POST as postOrgSites } from "../src/app/api/bff/orgs/[orgId]/sites/route";
import { POST as postOrgServices } from "../src/app/api/bff/orgs/[orgId]/sites/[siteId]/services/route";
import { POST as postOrgRevisions } from "../src/app/api/bff/orgs/[orgId]/services/[serviceId]/revisions/route";
import { POST as postOrgLifecycle } from "../src/app/api/bff/orgs/[orgId]/services/[serviceId]/lifecycle/route";

function extractCookiePair(res: Response): string {
  const setCookie = res.headers.get("set-cookie") || "";
  const match = setCookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
  return match ? `${SESSION_COOKIE_NAME}=${match[1]}` : "";
}

function extractRawCookieValue(res: Response): string {
  const setCookie = res.headers.get("set-cookie") || "";
  const match = setCookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
  return match ? match[1] || "" : "";
}

describe("Next.js 16 Encrypted JWE BFF Security Boundary & 3-Console Integration", () => {
  let server: http.Server;
  let serverUrl: string;
  let revokeCalled = false;
  const previousApiUrl = process.env.API_INTERNAL_URL;

  beforeAll(async () => {
    revokeCalled = false;
    server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
      const method = req.method || "GET";

      let bodyRaw = "";
      req.on("data", (chunk) => {
        bodyRaw += chunk;
      });

      req.on("end", () => {
        let body: Record<string, unknown> = {};
        if (bodyRaw) {
          try {
            body = JSON.parse(bodyRaw) as Record<string, unknown>;
          } catch {
            // ignore
          }
        }

        // Mock Upstream Routes
        if (method === "POST" && url.pathname === "/v1/dev/auth/token") {
          const personaId = (body.personaId as string) || "";
          const isCustomer = personaId.includes("customer");

          const responseData = {
            data: {
              accessToken: isCustomer
                ? "mock-customer-token-jwt-secret-val"
                : "mock-admin-token-jwt-secret-val-12345",
              user: {
                id: isCustomer ? "usr_customer_1" : "usr_admin_1",
                email: isCustomer ? "owner@acme.it" : "admin@platform.local",
                name: isCustomer ? "Giulia Rossi" : "Alice Fontana",
                globalRoles: isCustomer ? [] : ["infrastructure_admin"],
                hostingAdminOrgIds: [],
              },
            },
          };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(responseData));
          return;
        }

        if (method === "GET" && url.pathname === "/v1/me") {
          const auth = req.headers["authorization"] || "";
          if (!auth.startsWith("Bearer ")) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify(
                createErrorEnvelope({
                  code: "UNAUTHENTICATED",
                  message: "Token mancante o non valido",
                  requestId: "req-auth-fail",
                })
              )
            );
            return;
          }

          const isCustomer = auth.includes("mock-customer-token");

          const responseData = {
            data: {
              user: {
                id: isCustomer ? "usr_customer_1" : "usr_admin_1",
                email: isCustomer ? "owner@acme.it" : "admin@platform.local",
                name: isCustomer ? "Giulia Rossi" : "Alice Fontana",
              },
              globalRoles: isCustomer ? [] : ["infrastructure_admin"],
              hostingAdminOrgIds: [],
              memberships: [
                {
                  id: "mem_1",
                  organizationId: "org-acme",
                  organizationName: "Acme Corp",
                  organizationSlug: "acme-corp",
                  role: "customer_owner",
                  organizationStatus: "active",
                },
              ],
              platformCapabilities: {
                phase: "phase-1",
                hostingMode: "dedicated",
                sharedHostingEnabled: false,
                dockerExecutorRuntimeAvailable: false,
                hostAgentRuntimeAvailable: false,
                acmeTlsRuntimeAvailable: false,
                sftpAvailable: false,
                productionBackupRuntimeAvailable: false,
              },
            },
          };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(responseData));
          return;
        }

        if (method === "POST" && url.pathname === "/v1/auth/revoke") {
          revokeCalled = true;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (method === "PATCH" && url.pathname.includes("/v1/hosts/") && url.pathname.endsWith("/mode")) {
          if (body.hostingMode === "shared") {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify(
                createErrorEnvelope({
                  code: "SHARED_MODE_GATED",
                  message: "La modalità Shared è disabilitata nella Fase 1 del piano di controllo (AC-F1-06).",
                  requestId: "req-mode-gated",
                })
              )
            );
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: { hostingMode: body.hostingMode } }));
          return;
        }

        if (method === "POST" && url.pathname.includes("/v1/hosts/") && url.pathname.endsWith("/maintenance")) {
          res.writeHead(422, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify(
              createErrorEnvelope({
                code: "NOT_SUPPORTED",
                message: "Host agent maintenance runtime non attivo in Fase 1 (AC-F1-10).",
                requestId: "req-maint-unsupported",
              })
            )
          );
          return;
        }

        if (method === "POST" && url.pathname.includes("/v1/hosts/") && url.pathname.endsWith("/allocations")) {
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              data: {
                id: "alloc-new-01",
                hostId: "host-1",
                organizationId: body.organizationId || "org-acme",
                status: "active",
                hostingMode: "dedicated",
                dedicatedScope: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            })
          );
          return;
        }

        if (method === "POST" && url.pathname.endsWith("/sites")) {
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              data: {
                id: "site-new-01",
                organizationId: "org-acme",
                hostAllocationId: body.hostAllocationId || "alloc-01",
                name: body.name || "Test Site",
                slug: body.slug || "test-site",
                status: "ready",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            })
          );
          return;
        }

        if (method === "POST" && url.pathname.includes("/services") && !url.pathname.endsWith("/lifecycle") && !url.pathname.endsWith("/revisions")) {
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              data: {
                id: "svc-new-01",
                siteId: "site-01",
                organizationId: "org-acme",
                serviceTemplateId: body.serviceTemplateId || "tpl-node-app",
                name: body.name || "backend",
                desiredStatus: "running",
                currentRevisionId: "rev-01",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            })
          );
          return;
        }

        if (method === "POST" && url.pathname.endsWith("/revisions")) {
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              data: {
                id: "rev-new-01",
                serviceInstanceId: "svc-01",
                organizationId: "org-acme",
                revisionNumber: 1,
                specHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                declarativeConfig: {},
                secretRefs: {},
                resourceLimits: null,
                authorId: null,
                createdAt: new Date().toISOString(),
              },
            })
          );
          return;
        }

        if (method === "POST" && url.pathname.endsWith("/lifecycle")) {
          res.writeHead(422, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify(
              createErrorEnvelope({
                code: "NOT_SUPPORTED",
                message: "Docker executor runtime non attivo in Fase 1 (AC-F1-10).",
                requestId: "req-lifecycle-unsupported",
              })
            )
          );
          return;
        }

        // Fallback
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "Not found", requestId: "404" } }));
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        serverUrl = `http://127.0.0.1:${addr.port}`;
        process.env.API_INTERNAL_URL = serverUrl;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (previousApiUrl === undefined) {
      delete process.env.API_INTERNAL_URL;
    } else {
      process.env.API_INTERNAL_URL = previousApiUrl;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("1. Encrypted A256GCM HttpOnly hp_session login, zero accessToken or FORBIDDEN_PUBLIC_DTO_KEYS leaked, tampered JWE rejected", async () => {
    const loginReq = new Request("http://localhost:3000/api/session/login", {
      method: "POST",
      headers: {
        Host: "localhost:3000",
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ personaId: "persona-infra-admin" }),
    });

    const loginRes = await postLogin(loginReq);
    expect(loginRes.status).toBe(200);

    const setCookie = loginRes.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    expect(setCookie!).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie!).toContain("HttpOnly");
    expect(setCookie!.toLowerCase()).toContain("samesite=lax");
    expect(setCookie!).toContain("Path=/");

    const cookiePair = extractCookiePair(loginRes);
    const rawCookieValue = extractRawCookieValue(loginRes);
    expect(rawCookieValue.length).toBeGreaterThan(30);

    // Verify raw cookie is encrypted JWE and never exposes plaintext token
    expect(rawCookieValue).not.toContain("mock-admin-token");

    const decrypted = await decryptSession(rawCookieValue);
    expect(decrypted).not.toBeNull();
    expect(decrypted?.accessToken).toBe("mock-admin-token-jwt-secret-val-12345");
    expect(decrypted?.user.globalRoles).toContain("infrastructure_admin");

    // Tampered JWE must fail decryption
    const tampered = rawCookieValue.slice(0, -6) + "XXXXXX";
    expect(await decryptSession(tampered)).toBeNull();

    // GET /api/session
    const sessionRes = await getSession(
      new Request("http://localhost:3000/api/session", {
        headers: {
          Host: "localhost:3000",
          Cookie: cookiePair,
        },
      })
    );

    expect(sessionRes.status).toBe(200);
    const sessionBody = (await sessionRes.json()) as Record<string, unknown>;
    expect(sessionBody.authenticated).toBe(true);
    expect(typeof sessionBody.csrfToken).toBe("string");
    expect(sessionBody).not.toHaveProperty("accessToken");

    // Strictly assert zero forbidden public DTO keys
    const forbidden = findForbiddenPublicDtoKeys(sessionBody);
    expect(forbidden).toEqual([]);

    // Tampered session request
    const tamperedSessionRes = await getSession(
      new Request("http://localhost:3000/api/session", {
        headers: {
          Host: "localhost:3000",
          Cookie: `${SESSION_COOKIE_NAME}=${tampered}`,
        },
      })
    );
    const tamperedBody = (await tamperedSessionRes.json()) as { authenticated: boolean };
    expect(tamperedBody.authenticated).toBe(false);
  });

  it("2. Rejects mutating BFF routes with 403 PERMISSION_DENIED when X-CSRF-Token is missing or Origin is cross-site", async () => {
    const loginRes = await postLogin(
      new Request("http://localhost:3000/api/session/login", {
        method: "POST",
        headers: {
          Host: "localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ personaId: "persona-infra-admin" }),
      })
    );
    const cookiePair = extractCookiePair(loginRes);

    const sessionRes = await getSession(
      new Request("http://localhost:3000/api/session", {
        headers: { Host: "localhost:3000", Cookie: cookiePair },
      })
    );
    const sessionData = (await sessionRes.json()) as { csrfToken: string };

    // Case A: Missing X-CSRF-Token header
    const noCsrfRes = await postSwitchContext(
      new Request("http://localhost:3000/api/session/switch-context", {
        method: "POST",
        headers: {
          Host: "localhost:3000",
          Origin: "http://localhost:3000",
          Cookie: cookiePair,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ activeConsole: "infra" }),
      })
    );
    expect(noCsrfRes.status).toBe(403);
    const noCsrfJson = await noCsrfRes.json();
    const noCsrfErr = ApiErrorEnvelopeSchema.parse(noCsrfJson);
    expect(noCsrfErr.error.code).toBe("PERMISSION_DENIED");

    // Case B: Cross-site Origin (https://evil.example)
    const evilOriginRes = await postSwitchContext(
      new Request("http://localhost:3000/api/session/switch-context", {
        method: "POST",
        headers: {
          Host: "localhost:3000",
          Origin: "https://evil.example",
          Cookie: cookiePair,
          "X-CSRF-Token": sessionData.csrfToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ activeConsole: "infra" }),
      })
    );
    expect(evilOriginRes.status).toBe(403);
    const evilOriginJson = await evilOriginRes.json();
    const evilOriginErr = ApiErrorEnvelopeSchema.parse(evilOriginJson);
    expect(evilOriginErr.error.code).toBe("PERMISSION_DENIED");
  });

  it("3. POST /api/session/switch-context enforces membership (404 NOT_FOUND on unauthorized org, 200 on valid org)", async () => {
    // Login as customer without admin roles
    const loginRes = await postLogin(
      new Request("http://localhost:3000/api/session/login", {
        method: "POST",
        headers: {
          Host: "localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ personaId: "persona-customer-owner" }),
      })
    );
    const cookiePair = extractCookiePair(loginRes);

    const sessionRes = await getSession(
      new Request("http://localhost:3000/api/session", {
        headers: { Host: "localhost:3000", Cookie: cookiePair },
      })
    );
    const { csrfToken } = (await sessionRes.json()) as { csrfToken: string };

    // Valid switch to own organization
    const validSwitchRes = await postSwitchContext(
      new Request("http://localhost:3000/api/session/switch-context", {
        method: "POST",
        headers: {
          Host: "localhost:3000",
          Origin: "http://localhost:3000",
          Cookie: cookiePair,
          "X-CSRF-Token": csrfToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          activeConsole: "org",
          activeOrgSlug: "acme-corp",
        }),
      })
    );
    expect(validSwitchRes.status).toBe(200);
    const validJson = (await validSwitchRes.json()) as { ok: boolean; activeOrgSlug: string };
    expect(validJson.ok).toBe(true);
    expect(validJson.activeOrgSlug).toBe("acme-corp");

    // Switch to unauthorized organization
    const unauthorizedSwitchRes = await postSwitchContext(
      new Request("http://localhost:3000/api/session/switch-context", {
        method: "POST",
        headers: {
          Host: "localhost:3000",
          Origin: "http://localhost:3000",
          Cookie: cookiePair,
          "X-CSRF-Token": csrfToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          activeConsole: "org",
          activeOrgSlug: "unauthorized-tenant-x",
        }),
      })
    );
    expect(unauthorizedSwitchRes.status).toBe(404);
    const unauthJson = await unauthorizedSwitchRes.json();
    const unauthErr = ApiErrorEnvelopeSchema.parse(unauthJson);
    expect(unauthErr.error.code).toBe("NOT_FOUND");
  });

  it("4. Mutating BFF routes enforce Idempotency-Key, Shared Mode Gating (409), and Lifecycle Boundary (422 NOT_SUPPORTED)", async () => {
    const loginRes = await postLogin(
      new Request("http://localhost:3000/api/session/login", {
        method: "POST",
        headers: {
          Host: "localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ personaId: "persona-infra-admin" }),
      })
    );
    const cookiePair = extractCookiePair(loginRes);

    const sessionRes = await getSession(
      new Request("http://localhost:3000/api/session", {
        headers: { Host: "localhost:3000", Cookie: cookiePair },
      })
    );
    const { csrfToken } = (await sessionRes.json()) as { csrfToken: string };

    // A. POST /api/bff/orgs/:orgId/sites missing Idempotency-Key
    const missingIdemRes = await postOrgSites(
      new Request("http://localhost:3000/api/bff/orgs/org-acme/sites", {
        method: "POST",
        headers: {
          Host: "localhost:3000",
          Origin: "http://localhost:3000",
          Cookie: cookiePair,
          "X-CSRF-Token": csrfToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Test Site",
          slug: "test-site",
          hostAllocationId: "alloc-01",
        }),
      }),
      { params: Promise.resolve({ orgId: "org-acme" }) }
    );
    expect(missingIdemRes.status).toBe(400);
    const missingIdemJson = await missingIdemRes.json();
    const missingIdemErr = ApiErrorEnvelopeSchema.parse(missingIdemJson);
    expect(missingIdemErr.error.code).toBe("VALIDATION_ERROR");

    // B. POST /api/bff/orgs/:orgId/sites with Idempotency-Key succeeds
    const validSiteRes = await postOrgSites(
      new Request("http://localhost:3000/api/bff/orgs/org-acme/sites", {
        method: "POST",
        headers: {
          Host: "localhost:3000",
          Origin: "http://localhost:3000",
          Cookie: cookiePair,
          "X-CSRF-Token": csrfToken,
          "Idempotency-Key": "idem-site-test-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Test Site",
          slug: "test-site",
          hostAllocationId: "alloc-01",
        }),
      }),
      { params: Promise.resolve({ orgId: "org-acme" }) }
    );
    expect(validSiteRes.status).toBe(201);

    // C. PATCH /api/bff/hosts/:hostId/mode requesting shared returns 409 SHARED_MODE_GATED (AC-F1-06)
    const modeRes = await patchHostMode(
      new Request("http://localhost:3000/api/bff/hosts/host-1/mode", {
        method: "PATCH",
        headers: {
          Host: "localhost:3000",
          Origin: "http://localhost:3000",
          Cookie: cookiePair,
          "X-CSRF-Token": csrfToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ hostingMode: "shared", reason: "Test Gating" }),
      }),
      { params: Promise.resolve({ hostId: "host-1" }) }
    );
    expect(modeRes.status).toBe(409);
    const modeJson = await modeRes.json();
    const modeErr = ApiErrorEnvelopeSchema.parse(modeJson);
    expect(modeErr.error.code).toBe("SHARED_MODE_GATED");

    // D. POST /api/bff/orgs/:orgId/services/:serviceId/lifecycle returns 422 NOT_SUPPORTED (AC-F1-10)
    const lifecycleRes = await postOrgLifecycle(
      new Request("http://localhost:3000/api/bff/orgs/org-acme/services/svc-1/lifecycle", {
        method: "POST",
        headers: {
          Host: "localhost:3000",
          Origin: "http://localhost:3000",
          Cookie: cookiePair,
          "X-CSRF-Token": csrfToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "deploy" }),
      }),
      { params: Promise.resolve({ orgId: "org-acme", serviceId: "svc-1" }) }
    );
    expect(lifecycleRes.status).toBe(422);
    const lifecycleJson = await lifecycleRes.json();
    const lifecycleErr = ApiErrorEnvelopeSchema.parse(lifecycleJson);
    expect(lifecycleErr.error.code).toBe("NOT_SUPPORTED");

    // E. POST /api/bff/hosts/:hostId/maintenance returns 422 NOT_SUPPORTED (AC-F1-10)
    const maintRes = await postHostMaintenance(
      new Request("http://localhost:3000/api/bff/hosts/host-1/maintenance", {
        method: "POST",
        headers: {
          Host: "localhost:3000",
          Origin: "http://localhost:3000",
          Cookie: cookiePair,
          "X-CSRF-Token": csrfToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "drain" }),
      }),
      { params: Promise.resolve({ hostId: "host-1" }) }
    );
    expect(maintRes.status).toBe(422);

    // F. POST /api/bff/hosts/:hostId/allocations succeeds with 201
    const allocRes = await postHostAllocations(
      new Request("http://localhost:3000/api/bff/hosts/host-1/allocations", {
        method: "POST",
        headers: {
          Host: "localhost:3000",
          Origin: "http://localhost:3000",
          Cookie: cookiePair,
          "X-CSRF-Token": csrfToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ hostId: "host-1", organizationId: "org-acme" }),
      }),
      { params: Promise.resolve({ hostId: "host-1" }) }
    );
    expect(allocRes.status).toBe(201);

    // G. POST /api/bff/orgs/:orgId/sites/:siteId/services succeeds with 201
    const svcRes = await postOrgServices(
      new Request("http://localhost:3000/api/bff/orgs/org-acme/sites/site-01/services", {
        method: "POST",
        headers: {
          Host: "localhost:3000",
          Origin: "http://localhost:3000",
          Cookie: cookiePair,
          "X-CSRF-Token": csrfToken,
          "Idempotency-Key": "idem-svc-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "backend", serviceTemplateId: "tpl-1" }),
      }),
      { params: Promise.resolve({ orgId: "org-acme", siteId: "site-01" }) }
    );
    expect(svcRes.status).toBe(201);

    // H. POST /api/bff/orgs/:orgId/services/:serviceId/revisions succeeds with 201
    const revRes = await postOrgRevisions(
      new Request("http://localhost:3000/api/bff/orgs/org-acme/services/svc-1/revisions", {
        method: "POST",
        headers: {
          Host: "localhost:3000",
          Origin: "http://localhost:3000",
          Cookie: cookiePair,
          "X-CSRF-Token": csrfToken,
          "Idempotency-Key": "idem-rev-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ declarativeConfig: {} }),
      }),
      { params: Promise.resolve({ orgId: "org-acme", serviceId: "svc-1" }) }
    );
    expect(revRes.status).toBe(201);
  });

  it("5. POST /api/session/logout clears cookie and invokes upstream /v1/auth/revoke", async () => {
    const loginRes = await postLogin(
      new Request("http://localhost:3000/api/session/login", {
        method: "POST",
        headers: {
          Host: "localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ personaId: "persona-infra-admin" }),
      })
    );
    const cookiePair = extractCookiePair(loginRes);

    revokeCalled = false;
    const logoutRes = await postLogout(
      new Request("http://localhost:3000/api/session/logout", {
        method: "POST",
        headers: {
          Host: "localhost:3000",
          Cookie: cookiePair,
        },
      })
    );

    expect(logoutRes.status).toBe(200);
    const setCookie = logoutRes.headers.get("set-cookie") || "";
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=;`);
    expect(setCookie).toContain("Max-Age=0");
    expect(revokeCalled).toBe(true);
  });

  it("6. Static scan test asserts ZERO occurrences of legacy POC brand across apps/web/src and explicit AC-F1-10 Phase 1 boundary notices", () => {
    const webSrcDir = path.resolve(__dirname, "../src");
    expect(fs.existsSync(webSrcDir)).toBe(true);

    const forbiddenLegacyBrand = ["c", "o", "o", "l", "i", "f", "y"].join("");
    const files: string[] = [];
    function scan(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(full);
        } else if (/\.(ts|tsx|css|json)$/.test(entry.name)) {
          files.push(full);
        }
      }
    }
    scan(webSrcDir);

    expect(files.length).toBeGreaterThan(10);

    for (const filePath of files) {
      const content = fs.readFileSync(filePath, "utf-8");
      // Zero legacy mentions anywhere in src/
      expect(content.toLowerCase()).not.toContain(forbiddenLegacyBrand);
    }

    // Explicit AC-F1-10 Phase 1 boundary notices verified
    const hostDetailPage = fs.readFileSync(
      path.join(webSrcDir, "app/admin/hosts/[hostId]/page.tsx"),
      "utf-8"
    );
    expect(hostDetailPage).toContain("AC-F1-10");
    expect(hostDetailPage).toContain("Boundary Logico Definito — Runtime previsto in Fase 2");

    const overviewPage = fs.readFileSync(
      path.join(webSrcDir, "app/o/[orgSlug]/overview/page.tsx"),
      "utf-8"
    );
    expect(overviewPage).toContain("AC-F1-10");
    expect(overviewPage).toContain("Matrice Disponibilità Fase 1");
    expect(overviewPage).toContain("Non attivo in Fase 1 (Previsto Fase 2+)");
  });
});
