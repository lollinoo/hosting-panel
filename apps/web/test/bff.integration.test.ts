import { createControlPlaneApp, type ControlPlaneAppHandle } from "@hosting-panel/api";
import {
  ApiErrorEnvelopeSchema,
  AsyncAcceptedEnvelopeSchema,
  findForbiddenPublicDtoKeys,
  isTerminalOperationStatus,
  OPERATION_STATUSES,
  OperationDtoSchema,
} from "@hosting-panel/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as postAdminProviderTest } from "../src/app/api/bff/admin/providers/[id]/test/route";
import { POST as postDeployApp } from "../src/app/api/bff/orgs/[orgId]/applications/[appId]/deploy/route";
import { POST as postDomainRecheck } from "../src/app/api/bff/orgs/[orgId]/domains/[domainId]/recheck/route";
import { GET as getBffOperation } from "../src/app/api/bff/orgs/[orgId]/operations/[opId]/route";
import { POST as postLogin } from "../src/app/api/session/login/route";
import { POST as postLogout } from "../src/app/api/session/logout/route";
import { GET as getSession } from "../src/app/api/session/route";
import { POST as postSwitchOrg } from "../src/app/api/session/switch-org/route";
import {
  formatDatabaseBackupUnsupportedIt,
  formatOperationStatusIt,
} from "../src/lib/format";
import {
  extractCookieFromHeader,
  SESSION_COOKIE_NAME,
  unsealSession,
} from "../src/lib/session";

function extractCookiePairFromSetCookie(setCookieHeader: string | null): string {
  expect(setCookieHeader).toBeTruthy();
  const firstSegment = (setCookieHeader ?? "").split(";")[0]?.trim() ?? "";
  expect(firstSegment.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
  return firstSegment;
}

describe("Next.js 16 BFF Security Boundary & Async Operations Integration", () => {
  let apiHandle: ControlPlaneAppHandle;
  const previousApiUrl = process.env["API_INTERNAL_URL"];
  const previousSecret = process.env["BFF_SESSION_SECRET"];

  beforeAll(async () => {
    apiHandle = await createControlPlaneApp({
      port: 0,
      workerIntervalMs: 60,
    });
    expect(apiHandle.baseUrl).toBeTruthy();
    process.env["API_INTERNAL_URL"] = apiHandle.baseUrl ?? "";
    process.env["BFF_SESSION_SECRET"] =
      "vitest-bff-session-encryption-secret-key-2026!";
  });

  afterAll(async () => {
    if (previousApiUrl === undefined) {
      delete process.env["API_INTERNAL_URL"];
    } else {
      process.env["API_INTERNAL_URL"] = previousApiUrl;
    }

    if (previousSecret === undefined) {
      delete process.env["BFF_SESSION_SECRET"];
    } else {
      process.env["BFF_SESSION_SECRET"] = previousSecret;
    }

    await apiHandle.close();
  });

  it("1. issues an encrypted A256GCM HttpOnly cookie on login and exposes zero accessTokens or forbidden DTO keys on /api/session", async () => {
    const loginReq = new Request("http://localhost:3000/api/session/login", {
      method: "POST",
      headers: {
        Host: "localhost:3000",
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userId: "usr_elena" }),
    });

    const loginRes = await postLogin(loginReq);
    expect(loginRes.status).toBe(200);
    expect(loginRes.headers.get("cache-control")).toContain("no-store");

    const setCookie = loginRes.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");

    const cookiePair = extractCookiePairFromSetCookie(setCookie);
    const rawCookieValue = extractCookieFromHeader(cookiePair, SESSION_COOKIE_NAME);
    expect(rawCookieValue).toBeTruthy();
    // Encrypted JWE must never expose plaintext email or bearer JWT
    expect(rawCookieValue).not.toContain("elena.rossi@acme.it");

    const decrypted = await unsealSession(rawCookieValue);
    expect(decrypted).not.toBeNull();
    expect(decrypted?.accessToken.length).toBeGreaterThan(20);

    // Tampered JWE must fail decryption cleanly
    const tampered = `${rawCookieValue?.slice(0, -4) ?? ""}XXXX`;
    expect(await unsealSession(tampered)).toBeNull();

    const sessionRes = await getSession(
      new Request("http://localhost:3000/api/session", {
        method: "GET",
        headers: {
          Host: "localhost:3000",
          Cookie: cookiePair,
        },
      }),
    );

    expect(sessionRes.status).toBe(200);
    expect(sessionRes.headers.get("cache-control")).toContain("no-store");

    const sessionBody = (await sessionRes.json()) as Record<string, unknown>;
    expect(sessionBody["authenticated"]).toBe(true);
    expect(typeof sessionBody["csrfToken"]).toBe("string");
    expect(sessionBody).not.toHaveProperty("accessToken");

    const { csrfToken: _csrfNonce, ...publicWithoutCsrfNonce } = sessionBody;
    expect(findForbiddenPublicDtoKeys(publicWithoutCsrfNonce)).toEqual([]);
  });

  it("2. rejects mutating BFF routes (/deploy) with 403 PERMISSION_DENIED when X-CSRF-Token is missing or Origin is cross-site", async () => {
    const loginRes = await postLogin(
      new Request("http://localhost:3000/api/session/login", {
        method: "POST",
        headers: {
          Host: "localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ userId: "usr_elena" }),
      }),
    );
    const cookiePair = extractCookiePairFromSetCookie(
      loginRes.headers.get("set-cookie"),
    );
    const loginJson = (await loginRes.json()) as { readonly csrfToken: string };

    // Case A: Missing X-CSRF-Token header
    const noCsrfRes = await postDeployApp(
      new Request(
        "http://localhost:3000/api/bff/orgs/org_acme/applications/app_acme_storefront/deploy",
        {
          method: "POST",
          headers: {
            Host: "localhost:3000",
            Origin: "http://localhost:3000",
            Cookie: cookiePair,
            "Idempotency-Key": "idem_csrf_missing_001",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        },
      ),
      {
        params: Promise.resolve({
          orgId: "org_acme",
          appId: "app_acme_storefront",
        }),
      },
    );

    expect(noCsrfRes.status).toBe(403);
    const noCsrfErr = ApiErrorEnvelopeSchema.parse(await noCsrfRes.json());
    expect(noCsrfErr.error.code).toBe("PERMISSION_DENIED");

    // Case B: Valid X-CSRF-Token but cross-site Origin header
    const evilOriginRes = await postDeployApp(
      new Request(
        "http://localhost:3000/api/bff/orgs/org_acme/applications/app_acme_storefront/deploy",
        {
          method: "POST",
          headers: {
            Host: "localhost:3000",
            Origin: "https://evil.example",
            Cookie: cookiePair,
            "X-CSRF-Token": loginJson.csrfToken,
            "Idempotency-Key": "idem_evil_origin_001",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        },
      ),
      {
        params: Promise.resolve({
          orgId: "org_acme",
          appId: "app_acme_storefront",
        }),
      },
    );

    expect(evilOriginRes.status).toBe(403);
    const evilOriginErr = ApiErrorEnvelopeSchema.parse(await evilOriginRes.json());
    expect(evilOriginErr.error.code).toBe("PERMISSION_DENIED");
  });

  it("3. accepts valid POST /api/bff/orgs/.../deploy with 202 queued, sets no-store Cache-Control, and polls operation through to succeeded", async () => {
    const loginRes = await postLogin(
      new Request("http://localhost:3000/api/session/login", {
        method: "POST",
        headers: {
          Host: "localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ userId: "usr_elena" }),
      }),
    );
    const cookiePair = extractCookiePairFromSetCookie(
      loginRes.headers.get("set-cookie"),
    );
    const { csrfToken } = (await loginRes.json()) as { readonly csrfToken: string };

    const deployRes = await postDeployApp(
      new Request(
        "http://localhost:3000/api/bff/orgs/org_acme/applications/app_acme_storefront/deploy",
        {
          method: "POST",
          headers: {
            Host: "localhost:3000",
            Origin: "http://localhost:3000",
            Cookie: cookiePair,
            "X-CSRF-Token": csrfToken,
            "Idempotency-Key": "idem_bff_deploy_valid_001",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            reason: "Rilascio catalogo autunnale",
            forceRebuild: true,
          }),
        },
      ),
      {
        params: Promise.resolve({
          orgId: "org_acme",
          appId: "app_acme_storefront",
        }),
      },
    );

    expect(deployRes.status).toBe(202);
    expect(deployRes.headers.get("cache-control")).toContain("no-store");

    const rawAccepted = (await deployRes.json()) as unknown;
    expect(findForbiddenPublicDtoKeys(rawAccepted)).toEqual([]);
    const accepted = AsyncAcceptedEnvelopeSchema.parse(rawAccepted);
    expect(accepted.data.status).toBe("queued");

    const opId = accepted.data.operationId;
    let finalStatus = accepted.data.status;
    let latestStepsCount = 0;

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const pollRes = await getBffOperation(
        new Request(
          `http://localhost:3000/api/bff/orgs/org_acme/operations/${opId}`,
          {
            method: "GET",
            headers: {
              Host: "localhost:3000",
              Cookie: cookiePair,
            },
          },
        ),
        {
          params: Promise.resolve({
            orgId: "org_acme",
            opId,
          }),
        },
      );

      expect(pollRes.status).toBe(200);
      expect(pollRes.headers.get("cache-control")).toContain("no-store");

      const rawOpBody = (await pollRes.json()) as { readonly data: unknown };
      expect(findForbiddenPublicDtoKeys(rawOpBody)).toEqual([]);
      const opDto = OperationDtoSchema.parse(rawOpBody.data);
      finalStatus = opDto.status;
      latestStepsCount = opDto.steps.length;

      if (isTerminalOperationStatus(opDto.status)) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 75));
    }

    expect(finalStatus).toBe("succeeded");
    expect(latestStepsCount).toBeGreaterThanOrEqual(3);

    // Also verify domain TLS recheck BFF route works end-to-end
    const recheckRes = await postDomainRecheck(
      new Request(
        "http://localhost:3000/api/bff/orgs/org_acme/domains/dom_acme_store/recheck",
        {
          method: "POST",
          headers: {
            Host: "localhost:3000",
            Origin: "http://localhost:3000",
            Cookie: cookiePair,
            "X-CSRF-Token": csrfToken,
            "Idempotency-Key": "idem_bff_tls_recheck_001",
          },
        },
      ),
      {
        params: Promise.resolve({
          orgId: "org_acme",
          domainId: "dom_acme_store",
        }),
      },
    );
    expect(recheckRes.status).toBe(202);
  });

  it("4. enforces membership on POST /api/session/switch-org (404 on unauthorized org, 200 on valid second org AC-002)", async () => {
    // Marco is only a member of acme-cloud, NOT beta-studios
    const marcoLogin = await postLogin(
      new Request("http://localhost:3000/api/session/login", {
        method: "POST",
        headers: {
          Host: "localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ userId: "usr_marco" }),
      }),
    );
    const marcoCookie = extractCookiePairFromSetCookie(
      marcoLogin.headers.get("set-cookie"),
    );
    const marcoBody = (await marcoLogin.json()) as { readonly csrfToken: string };

    const forbiddenSwitch = await postSwitchOrg(
      new Request("http://localhost:3000/api/session/switch-org", {
        method: "POST",
        headers: {
          Host: "localhost:3000",
          Origin: "http://localhost:3000",
          Cookie: marcoCookie,
          "X-CSRF-Token": marcoBody.csrfToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ organizationSlug: "beta-studios" }),
      }),
    );
    expect(forbiddenSwitch.status).toBe(404);
    const switchErr = ApiErrorEnvelopeSchema.parse(await forbiddenSwitch.json());
    expect(switchErr.error.code).toBe("NOT_FOUND");

    // Elena is a member of both acme-cloud and beta-studios
    const elenaLogin = await postLogin(
      new Request("http://localhost:3000/api/session/login", {
        method: "POST",
        headers: {
          Host: "localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          userId: "usr_elena",
          preferredOrgSlug: "acme-cloud",
        }),
      }),
    );
    const elenaCookie = extractCookiePairFromSetCookie(
      elenaLogin.headers.get("set-cookie"),
    );
    const elenaBody = (await elenaLogin.json()) as {
      readonly csrfToken: string;
      readonly activeOrgSlug: string | null;
    };
    expect(elenaBody.activeOrgSlug).toBe("acme-cloud");

    const validSwitch = await postSwitchOrg(
      new Request("http://localhost:3000/api/session/switch-org", {
        method: "POST",
        headers: {
          Host: "localhost:3000",
          Origin: "http://localhost:3000",
          Cookie: elenaCookie,
          "X-CSRF-Token": elenaBody.csrfToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ organizationSlug: "beta-studios" }),
      }),
    );
    expect(validSwitch.status).toBe(200);
    const updatedCookie = extractCookiePairFromSetCookie(
      validSwitch.headers.get("set-cookie"),
    );

    const sessionCheck = await getSession(
      new Request("http://localhost:3000/api/session", {
        method: "GET",
        headers: {
          Host: "localhost:3000",
          Cookie: updatedCookie,
        },
      }),
    );
    const sessionCheckBody = (await sessionCheck.json()) as {
      readonly activeOrgSlug: string | null;
    };
    expect(sessionCheckBody.activeOrgSlug).toBe("beta-studios");
  });

  it("5. clears HttpOnly cookie AND revokes upstream JWT jti on POST /api/session/logout (AC-024)", async () => {
    const loginRes = await postLogin(
      new Request("http://localhost:3000/api/session/login", {
        method: "POST",
        headers: {
          Host: "localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ userId: "usr_giulia" }),
      }),
    );
    const cookiePair = extractCookiePairFromSetCookie(
      loginRes.headers.get("set-cookie"),
    );
    const { csrfToken } = (await loginRes.json()) as { readonly csrfToken: string };

    const rawValue = extractCookieFromHeader(cookiePair, SESSION_COOKIE_NAME);
    const unsealedBefore = await unsealSession(rawValue);
    expect(unsealedBefore).not.toBeNull();
    const upstreamJwt = unsealedBefore?.accessToken ?? "";

    // Confirm token works upstream before logout
    const meBefore = await fetch(`${apiHandle.baseUrl ?? ""}/v1/me`, {
      headers: { Authorization: `Bearer ${upstreamJwt}` },
    });
    expect(meBefore.status).toBe(200);

    // Execute BFF logout
    const logoutRes = await postLogout(
      new Request("http://localhost:3000/api/session/logout", {
        method: "POST",
        headers: {
          Host: "localhost:3000",
          Origin: "http://localhost:3000",
          Cookie: cookiePair,
          "X-CSRF-Token": csrfToken,
        },
      }),
    );
    expect(logoutRes.status).toBe(200);
    const clearCookieHeader = logoutRes.headers.get("set-cookie") ?? "";
    expect(clearCookieHeader).toContain(`${SESSION_COOKIE_NAME}=;`);
    expect(clearCookieHeader).toContain("Max-Age=0");

    // Upstream API MUST reject the revoked JWT jti immediately (AC-024)
    const meAfter = await fetch(`${apiHandle.baseUrl ?? ""}/v1/me`, {
      headers: { Authorization: `Bearer ${upstreamJwt}` },
    });
    expect(meAfter.status).toBe(401);

    // Replaying the old cookie on /api/session also yields unauthenticated
    const sessionAfter = await getSession(
      new Request("http://localhost:3000/api/session", {
        method: "GET",
        headers: {
          Host: "localhost:3000",
          Cookie: cookiePair,
        },
      }),
    );
    const sessionAfterJson = (await sessionAfter.json()) as {
      readonly authenticated: boolean;
    };
    expect(sessionAfterJson.authenticated).toBe(false);
  });

  it("6. guards admin provider test BFF route to platform_admin and enforces Italian UI status invariants", async () => {
    const adminLogin = await postLogin(
      new Request("http://localhost:3000/api/session/login", {
        method: "POST",
        headers: {
          Host: "localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ userId: "usr_admin" }),
      }),
    );
    const adminCookie = extractCookiePairFromSetCookie(
      adminLogin.headers.get("set-cookie"),
    );
    const adminBody = (await adminLogin.json()) as {
      readonly csrfToken: string;
      readonly redirectTo: string;
    };
    expect(adminBody.redirectTo).toBe("/admin/overview");

    const testRes = await postAdminProviderTest(
      new Request(
        "http://localhost:3000/api/bff/admin/providers/prv_coolify_lab/test",
        {
          method: "POST",
          headers: {
            Host: "localhost:3000",
            Origin: "http://localhost:3000",
            Cookie: adminCookie,
            "X-CSRF-Token": adminBody.csrfToken,
          },
        },
      ),
      {
        params: Promise.resolve({ id: "prv_coolify_lab" }),
      },
    );
    expect(testRes.status).toBe(200);
    const providerTestJson = (await testRes.json()) as unknown;
    expect(findForbiddenPublicDtoKeys(providerTestJson)).toEqual([]);

    // Non-terminal operation statuses MUST NEVER be labeled "Completata"
    for (const status of OPERATION_STATUSES) {
      const formatted = formatOperationStatusIt(status);
      if (status !== "succeeded") {
        expect(formatted.label).not.toBe("Completata");
      } else {
        expect(formatted.label).toBe("Completata");
      }
    }

    expect(formatDatabaseBackupUnsupportedIt("redis", null)).toContain(
      "Backup e ripristino automatici non supportati per istanze Redis",
    );
  });
});
