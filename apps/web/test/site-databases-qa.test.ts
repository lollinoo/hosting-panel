import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SiteDatabaseCreatedDtoSchema,
  SiteDatabasePasswordResetDtoSchema,
  SiteDatabaseSignOnDtoSchema,
  SiteDatabaseUserCreatedDtoSchema,
  SiteDatabasesDtoSchema,
  type SiteDatabasesDto,
} from "@hosting-panel/contracts";

const fetchUpstreamMock = vi.fn();
const getSessionFromRequestMock = vi.fn();

vi.mock("@/lib/upstream", () => ({
  fetchUpstream: (...args: unknown[]) => fetchUpstreamMock(...args),
}));

vi.mock("@/lib/server-session", () => ({
  getSessionFromRequest: (...args: unknown[]) => getSessionFromRequestMock(...args),
}));

vi.mock("@/i18n/server", () => ({
  getServerLocale: async () => "en",
}));

import {
  GET as getDatabases,
  POST as postDatabases,
} from "../src/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/databases/route";
import { DELETE as deleteDatabase } from "../src/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/databases/[name]/route";
import { POST as postPhpMyAdmin } from "../src/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/databases/phpmyadmin/route";
import { POST as postDatabaseUser } from "../src/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/database-users/route";
import { DELETE as deleteDatabaseUser } from "../src/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/database-users/[name]/route";
import { POST as postResetPassword } from "../src/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/database-users/[name]/reset-password/route";
import {
  PUT as putGrant,
  DELETE as deleteGrant,
} from "../src/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/database-users/[name]/grants/[database]/route";
import { SiteDatabases, databaseErrorText } from "../src/components/customer/site-databases";
import { I18nProvider } from "../src/i18n/provider";
import { en } from "../src/i18n/en";
import { it as itMsgs } from "../src/i18n/it";

const ORG_ID = "org_01";
const SITE_ID = "0123456789abcdef_site";
const PREFIX = "wp_0123456789ab";
const DB_NAME = `${PREFIX}_shop`;
const USER_NAME = `${PREFIX}_editor`;
const CSRF = "csrf-qa-token";
const BASE_URL = `http://localhost:3000/api/bff/orgs/${ORG_ID}/managed-sites/${SITE_ID}/databases`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

function makeRequest(
  method: string,
  opts: {
    url?: string;
    body?: string;
    csrf?: string | null;
    origin?: string | null;
  } = {},
): NextRequest {
  const headers = new Headers();
  headers.set("Host", "localhost:3000");
  if (opts.origin !== null) {
    headers.set("Origin", opts.origin ?? "http://localhost:3000");
  }
  if (opts.csrf !== null && method !== "GET") {
    headers.set("X-CSRF-Token", opts.csrf ?? CSRF);
  }
  if (opts.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  return new NextRequest(opts.url ?? BASE_URL, {
    method,
    headers,
    body: opts.body,
  });
}

function p<T extends Record<string, string>>(obj: T): { params: Promise<T> } {
  return { params: Promise.resolve(obj) };
}

function collectStrings(node: unknown, out: Array<{ path: string; text: string }> = [], prefix = ""): Array<{ path: string; text: string }> {
  if (typeof node === "string") {
    out.push({ path: prefix, text: node });
    return out;
  }
  if (node && typeof node === "object") {
    for (const [key, val] of Object.entries(node)) {
      collectStrings(val, out, prefix ? `${prefix}.${key}` : key);
    }
  }
  return out;
}

describe("site databases & phpMyAdmin web BFF QA", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionFromRequestMock.mockResolvedValue({
      userId: "u_1",
      email: "owner@qa.test",
      role: "customer_owner",
      accessToken: "upstream-jwt",
      csrfToken: CSRF,
    });
  });

  it("refuses hostile path segments across all BFF routes before calling API", async () => {
    const hostile = [
      "bad'quote",
      "bad`tick",
      "bad;semi",
      "bad%pct",
      "../escape",
      "..%2Fescape",
      "a/b",
      "a%2Fb",
      "bad\u0000nul",
      "bad%00nul",
      "x".repeat(200),
    ];

    for (const seg of hostile) {
      const checks = [
        () => getDatabases(makeRequest("GET"), p({ orgId: seg, siteId: SITE_ID })),
        () => getDatabases(makeRequest("GET"), p({ orgId: ORG_ID, siteId: seg })),
        () => postDatabases(makeRequest("POST", { body: JSON.stringify({ name: "ok" }) }), p({ orgId: seg, siteId: SITE_ID })),
        () => postDatabases(makeRequest("POST", { body: JSON.stringify({ name: "ok" }) }), p({ orgId: ORG_ID, siteId: seg })),
        () => deleteDatabase(makeRequest("DELETE"), p({ orgId: ORG_ID, siteId: SITE_ID, name: seg })),
        () => deleteDatabase(makeRequest("DELETE"), p({ orgId: seg, siteId: SITE_ID, name: DB_NAME })),
        () => postPhpMyAdmin(makeRequest("POST", { body: "{}" }), p({ orgId: seg, siteId: SITE_ID })),
        () => postPhpMyAdmin(makeRequest("POST", { body: "{}" }), p({ orgId: ORG_ID, siteId: seg })),
        () => postDatabaseUser(makeRequest("POST", { body: JSON.stringify({ name: "ok" }) }), p({ orgId: seg, siteId: SITE_ID })),
        () => deleteDatabaseUser(makeRequest("DELETE"), p({ orgId: ORG_ID, siteId: SITE_ID, name: seg })),
        () => postResetPassword(makeRequest("POST"), p({ orgId: ORG_ID, siteId: SITE_ID, name: seg })),
        () => putGrant(makeRequest("PUT"), p({ orgId: ORG_ID, siteId: SITE_ID, name: seg, database: DB_NAME })),
        () => putGrant(makeRequest("PUT"), p({ orgId: ORG_ID, siteId: SITE_ID, name: USER_NAME, database: seg })),
        () => deleteGrant(makeRequest("DELETE"), p({ orgId: ORG_ID, siteId: SITE_ID, name: seg, database: DB_NAME })),
        () => deleteGrant(makeRequest("DELETE"), p({ orgId: ORG_ID, siteId: SITE_ID, name: USER_NAME, database: seg })),
      ];
      for (const run of checks) {
        const res = await run();
        expect(res.status).toBe(400);
        const body = (await res.json()) as Json;
        expect(body.error.code).toBe("VALIDATION_ERROR");
      }
    }

    const upperChecks = [
      () => deleteDatabase(makeRequest("DELETE"), p({ orgId: ORG_ID, siteId: SITE_ID, name: `${PREFIX}_Shop` })),
      () => deleteDatabaseUser(makeRequest("DELETE"), p({ orgId: ORG_ID, siteId: SITE_ID, name: `${PREFIX}_User` })),
      () => postResetPassword(makeRequest("POST"), p({ orgId: ORG_ID, siteId: SITE_ID, name: `${PREFIX}_User` })),
      () => putGrant(makeRequest("PUT"), p({ orgId: ORG_ID, siteId: SITE_ID, name: `${PREFIX}_User`, database: DB_NAME })),
      () => deleteGrant(makeRequest("DELETE"), p({ orgId: ORG_ID, siteId: SITE_ID, name: USER_NAME, database: `${PREFIX}_DB` })),
    ];
    for (const run of upperChecks) {
      const res = await run();
      expect(res.status).toBe(400);
    }

    expect(fetchUpstreamMock).not.toHaveBeenCalled();
  });

  it("refuses mutations without CSRF token or from a foreign origin before calling API", async () => {
    const invocations: Array<(req: NextRequest) => Promise<Response>> = [
      (req) => postDatabases(req, p({ orgId: ORG_ID, siteId: SITE_ID })),
      (req) => deleteDatabase(req, p({ orgId: ORG_ID, siteId: SITE_ID, name: DB_NAME })),
      (req) => postPhpMyAdmin(req, p({ orgId: ORG_ID, siteId: SITE_ID })),
      (req) => postDatabaseUser(req, p({ orgId: ORG_ID, siteId: SITE_ID })),
      (req) => deleteDatabaseUser(req, p({ orgId: ORG_ID, siteId: SITE_ID, name: USER_NAME })),
      (req) => postResetPassword(req, p({ orgId: ORG_ID, siteId: SITE_ID, name: USER_NAME })),
      (req) => putGrant(req, p({ orgId: ORG_ID, siteId: SITE_ID, name: USER_NAME, database: DB_NAME })),
      (req) => deleteGrant(req, p({ orgId: ORG_ID, siteId: SITE_ID, name: USER_NAME, database: DB_NAME })),
    ];

    for (const fn of invocations) {
      const noCsrf = await fn(makeRequest("POST", { body: "{}", csrf: null }));
      expect(noCsrf.status).toBe(403);

      const badCsrf = await fn(makeRequest("POST", { body: "{}", csrf: "wrong-token" }));
      expect(badCsrf.status).toBe(403);

      const foreignOrigin = await fn(makeRequest("POST", { body: "{}", origin: "https://evil.example" }));
      expect(foreignOrigin.status).toBe(403);
    }

    expect(fetchUpstreamMock).not.toHaveBeenCalled();
  });

  it("passes API errors through with their error code on every web route", async () => {
    const routes: Array<() => Promise<Response>> = [
      () => getDatabases(makeRequest("GET"), p({ orgId: ORG_ID, siteId: SITE_ID })),
      () => postDatabases(makeRequest("POST", { body: JSON.stringify({ name: "shop" }) }), p({ orgId: ORG_ID, siteId: SITE_ID })),
      () => deleteDatabase(makeRequest("DELETE"), p({ orgId: ORG_ID, siteId: SITE_ID, name: DB_NAME })),
      () => postPhpMyAdmin(makeRequest("POST", { body: "{}" }), p({ orgId: ORG_ID, siteId: SITE_ID })),
      () => postDatabaseUser(makeRequest("POST", { body: JSON.stringify({ name: "editor" }) }), p({ orgId: ORG_ID, siteId: SITE_ID })),
      () => deleteDatabaseUser(makeRequest("DELETE"), p({ orgId: ORG_ID, siteId: SITE_ID, name: USER_NAME })),
      () => postResetPassword(makeRequest("POST"), p({ orgId: ORG_ID, siteId: SITE_ID, name: USER_NAME })),
      () => putGrant(makeRequest("PUT"), p({ orgId: ORG_ID, siteId: SITE_ID, name: USER_NAME, database: DB_NAME })),
      () => deleteGrant(makeRequest("DELETE"), p({ orgId: ORG_ID, siteId: SITE_ID, name: USER_NAME, database: DB_NAME })),
    ];

    for (const call of routes) {
      fetchUpstreamMock.mockResolvedValueOnce({
        ok: false,
        status: 409,
        error: { error: { code: "RESOURCE_LOCKED", message: "Site busy", retryable: true } },
      });
      const res = await call();
      expect(res.status).toBe(409);
      const json = (await res.json()) as Json;
      expect(json.error.code).toBe("RESOURCE_LOCKED");
    }
  });

  it("sign-on route never reveals username or temporaryPassword regardless of upstream payload or extra fields", async () => {
    const secretUser = "pma_0123456789ab";
    const secretPass = "SuperSecretPmaPass98765412";

    // Valid upstream response
    fetchUpstreamMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { data: { username: secretUser, temporaryPassword: secretPass } },
    });
    const okRes = await postPhpMyAdmin(makeRequest("POST", { body: "{}" }), p({ orgId: ORG_ID, siteId: SITE_ID }));
    expect(okRes.status).toBe(200);
    const okText = await okRes.text();
    expect(JSON.parse(okText)).toEqual({ data: { url: `/phpmyadmin/${SITE_ID}/` } });
    expect(okText).not.toContain(secretUser);
    expect(okText).not.toContain(secretPass);
    expect(okText).not.toContain("temporaryPassword");
    expect(okText).not.toContain("username");
    expect(okRes.headers.get("set-cookie")).toContain("hp_pma=");

    // Extra field inside inner data -> rejected, no cookie, no leak
    fetchUpstreamMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { data: { username: secretUser, temporaryPassword: secretPass, unexpected: "extra" } },
    });
    const extraInner = await postPhpMyAdmin(makeRequest("POST", { body: "{}" }), p({ orgId: ORG_ID, siteId: SITE_ID }));
    const extraInnerText = await extraInner.text();
    expect(extraInner.status).toBe(502);
    expect(extraInner.headers.get("set-cookie")).toBeNull();
    expect(extraInnerText).not.toContain(secretUser);
    expect(extraInnerText).not.toContain(secretPass);

    // Extra field on outer envelope -> still never echoes username/temporaryPassword
    fetchUpstreamMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        data: { username: secretUser, temporaryPassword: secretPass },
        temporaryPassword: secretPass,
        extra: "outer",
      },
    });
    const extraOuter = await postPhpMyAdmin(makeRequest("POST", { body: "{}" }), p({ orgId: ORG_ID, siteId: SITE_ID }));
    const extraOuterText = await extraOuter.text();
    expect(extraOuterText).not.toContain(secretUser);
    expect(extraOuterText).not.toContain(secretPass);
    expect(extraOuterText).not.toContain("temporaryPassword");
    expect(extraOuterText).not.toContain("username");
  });

  it("only returns temporaryPassword from create user and reset password with real API shapes, and never exposes sign-on credentials", async () => {
    const tempPw = "InjectedTempPasswordShouldNotLeak99";
    const pmaUser = "pma_0123456789ab";

    // Only create user and reset password return temporaryPassword (matching contract DTO shapes)
    const createUserData = SiteDatabaseUserCreatedDtoSchema.parse({
      user: { name: USER_NAME, primary: false, databases: [] },
      temporaryPassword: tempPw,
    });
    fetchUpstreamMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      data: { data: createUserData },
    });
    const createdUserRes = await postDatabaseUser(
      makeRequest("POST", { body: JSON.stringify({ name: "editor" }) }),
      p({ orgId: ORG_ID, siteId: SITE_ID }),
    );
    expect(createdUserRes.status).toBe(201);
    expect((await createdUserRes.json()).data.temporaryPassword).toBe(tempPw);

    const resetData = SiteDatabasePasswordResetDtoSchema.parse({
      temporaryPassword: tempPw,
    });
    fetchUpstreamMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { data: resetData },
    });
    const resetRes = await postResetPassword(
      makeRequest("POST"),
      p({ orgId: ORG_ID, siteId: SITE_ID, name: USER_NAME }),
    );
    expect(resetRes.status).toBe(200);
    expect((await resetRes.json()).data.temporaryPassword).toBe(tempPw);

    // Other database CRUD routes receive real API shapes (no temporaryPassword in contract)
    const listData = SiteDatabasesDtoSchema.parse({
      prefix: PREFIX,
      databases: [{ name: PREFIX, primary: true, sizeBytes: 4096 }],
      users: [{ name: PREFIX, primary: true, databases: [PREFIX] }],
      limits: { databases: 10, users: 10 },
      phpMyAdminAvailable: true,
    });
    const createdDbData = SiteDatabaseCreatedDtoSchema.parse({
      database: { name: DB_NAME, primary: false, sizeBytes: 0 },
    });

    const otherRoutes: Array<{ label: string; call: () => Promise<Response>; status: number; payload: Json | null }> = [
      {
        label: "GET databases",
        call: () => getDatabases(makeRequest("GET"), p({ orgId: ORG_ID, siteId: SITE_ID })),
        status: 200,
        payload: { data: listData },
      },
      {
        label: "POST databases",
        call: () =>
          postDatabases(
            makeRequest("POST", { body: JSON.stringify({ name: "shop" }) }),
            p({ orgId: ORG_ID, siteId: SITE_ID }),
          ),
        status: 201,
        payload: { data: createdDbData },
      },
      {
        label: "DELETE databases/[name]",
        call: () => deleteDatabase(makeRequest("DELETE"), p({ orgId: ORG_ID, siteId: SITE_ID, name: DB_NAME })),
        status: 204,
        payload: null,
      },
      {
        label: "DELETE database-users/[name]",
        call: () => deleteDatabaseUser(makeRequest("DELETE"), p({ orgId: ORG_ID, siteId: SITE_ID, name: USER_NAME })),
        status: 204,
        payload: null,
      },
      {
        label: "PUT grants/[database]",
        call: () => putGrant(makeRequest("PUT"), p({ orgId: ORG_ID, siteId: SITE_ID, name: USER_NAME, database: DB_NAME })),
        status: 204,
        payload: null,
      },
      {
        label: "DELETE grants/[database]",
        call: () => deleteGrant(makeRequest("DELETE"), p({ orgId: ORG_ID, siteId: SITE_ID, name: USER_NAME, database: DB_NAME })),
        status: 204,
        payload: null,
      },
    ];

    for (const item of otherRoutes) {
      fetchUpstreamMock.mockResolvedValueOnce({
        ok: true,
        status: item.status,
        data: item.payload,
      });
      const res = await item.call();
      expect(res.status).toBe(item.status);
      const bodyText = await res.text();
      expect(bodyText, `${item.label} contained temporaryPassword`).not.toContain(tempPw);
      expect(bodyText, `${item.label} contained temporaryPassword key`).not.toContain("temporaryPassword");
    }

    // phpMyAdmin sign-on route never returns a username or password, whatever the API answers
    const signOnData = SiteDatabaseSignOnDtoSchema.parse({
      username: pmaUser,
      temporaryPassword: tempPw,
    });
    fetchUpstreamMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { data: signOnData },
    });
    const signOnRes = await postPhpMyAdmin(
      makeRequest("POST", { body: "{}" }),
      p({ orgId: ORG_ID, siteId: SITE_ID }),
    );
    expect(signOnRes.status).toBe(200);
    const signOnBody = await signOnRes.text();
    expect(JSON.parse(signOnBody)).toEqual({ data: { url: `/phpmyadmin/${SITE_ID}/` } });
    expect(signOnBody).not.toContain(pmaUser);
    expect(signOnBody).not.toContain(tempPw);
    expect(signOnBody).not.toContain("username");
    expect(signOnBody).not.toContain("temporaryPassword");

    // Even if upstream returns unexpected/extra credential fields on sign-on, the route rejects (502) and leaks nothing
    fetchUpstreamMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { data: { username: pmaUser, temporaryPassword: tempPw, extraLeak: tempPw } },
    });
    const badSignOnRes = await postPhpMyAdmin(
      makeRequest("POST", { body: "{}" }),
      p({ orgId: ORG_ID, siteId: SITE_ID }),
    );
    expect(badSignOnRes.status).toBe(502);
    const badSignOnBody = await badSignOnRes.text();
    expect(badSignOnBody).not.toContain(pmaUser);
    expect(badSignOnBody).not.toContain(tempPw);
    expect(badSignOnBody).not.toContain("username");
    expect(badSignOnBody).not.toContain("temporaryPassword");
  });
});

describe("site databases UI & i18n catalog QA", () => {
  function sampleDto(phpMyAdminAvailable: boolean): SiteDatabasesDto {
    const extraDbs = Array.from({ length: 9 }, (_, i) => ({
      name: `${PREFIX}_db${i + 1}`,
      primary: false,
      sizeBytes: (i + 1) * 1024 * 1024,
    }));
    return {
      prefix: PREFIX,
      databases: [{ name: PREFIX, primary: true, sizeBytes: 4 * 1024 * 1024 }, ...extraDbs],
      users: [
        { name: PREFIX, primary: true, databases: [PREFIX] },
        {
          name: `${PREFIX}_multi`,
          primary: false,
          databases: [PREFIX, `${PREFIX}_db1`],
        },
      ],
      limits: { databases: 10, users: 10 },
      phpMyAdminAvailable,
    };
  }

  function decodeHtml(html: string): string {
    return html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  }

  it("renders primary db/user, ten databases, two-database user grants, and phpMyAdminAvailable true vs false", () => {
    const htmlOn = decodeHtml(
      renderToStaticMarkup(
        createElement(
          I18nProvider,
          {
            locale: "en",
            messages: en,
            children: createElement(SiteDatabases, {
              siteId: SITE_ID,
              orgId: ORG_ID,
              basePath: `/api/bff/orgs/${ORG_ID}/managed-sites/${SITE_ID}`,
              initial: sampleDto(true),
              csrfToken: CSRF,
            }),
          },
        ),
      ),
    );

    expect(htmlOn).toContain(PREFIX);
    for (let i = 1; i <= 9; i += 1) {
      expect(htmlOn).toContain(`${PREFIX}_db${i}`);
    }
    expect(htmlOn).toContain(`${PREFIX}_multi`);
    expect(htmlOn).toContain(`>${en.site.database.phpmyadmin.open}<`);
    expect(htmlOn).not.toContain(en.site.database.phpmyadmin.unavailable);
    expect(htmlOn).toContain(en.site.database.primaryBadge);

    const htmlOff = decodeHtml(
      renderToStaticMarkup(
        createElement(
          I18nProvider,
          {
            locale: "en",
            messages: en,
            children: createElement(SiteDatabases, {
              siteId: SITE_ID,
              orgId: ORG_ID,
              basePath: `/api/bff/orgs/${ORG_ID}/managed-sites/${SITE_ID}`,
              initial: sampleDto(false),
              csrfToken: CSRF,
            }),
          },
        ),
      ),
    );
    expect(htmlOff).toContain(en.site.database.phpmyadmin.unavailable);
    expect(htmlOff).not.toContain(`>${en.site.database.phpmyadmin.open}<`);
  });

  it("translates every API error code in both Italian and English without raw codes or generic fallback", () => {
    const apiCodes = [
      "VALIDATION_ERROR",
      "ALREADY_EXISTS",
      "NOT_FOUND",
      "QUOTA_EXCEEDED",
      "RESOURCE_LOCKED",
      "ORGANIZATION_SUSPENDED",
      "DOCKER_ENGINE_UNAVAILABLE",
      "NOT_SUPPORTED",
      "UNAUTHENTICATED",
      "PERMISSION_DENIED",
      "INTERNAL_ERROR",
    ];

    for (const [locale, catalog] of [
      ["en", en],
      ["it", itMsgs],
    ] as const) {
      for (const code of apiCodes) {
        const text = databaseErrorText(catalog, code);
        expect(text, `${locale}:${code} empty`).toBeTruthy();
        expect(text, `${locale}:${code} contains raw code`).not.toContain(code);
        expect(text, `${locale}:${code} fell back to generic`).not.toBe(catalog.errors.generic);
      }
    }
  });

  it("keeps all site.database copy free of infrastructure jargon, tells what to do on failures, and states consequences on confirmations", () => {
    const forbidden = /\b(docker|container|image|volume|network|revision)\b/i;

    const missingNextStep: string[] = [];
    for (const [locale, catalog] of [
      ["en", en],
      ["it", itMsgs],
    ] as const) {
      const leaves = collectStrings(catalog.site.database, [], "site.database");
      expect(leaves.length).toBeGreaterThan(20);
      for (const leaf of leaves) {
        expect(leaf.text, `${locale} ${leaf.path} mentions forbidden jargon`).not.toMatch(forbidden);
      }

      const failureTexts = [
        ...Object.entries(catalog.site.database.errors).map(([k, v]) => ({
          key: `errors.${k}`,
          text: v,
        })),
        { key: "unavailable", text: catalog.site.database.unavailable },
        { key: "loadFailed", text: catalog.site.database.loadFailed },
        { key: "phpmyadmin.unavailable", text: catalog.site.database.phpmyadmin.unavailable },
        { key: "phpmyadmin.popupBlocked", text: catalog.site.database.phpmyadmin.popupBlocked },
        { key: "phpmyadmin.downBody", text: catalog.site.database.phpmyadmin.downBody },
      ];
      const nextStepPattern =
        locale === "en"
          ? /\b(try again|wait|allow|check|delete|choose|contact|ask|use|sign in|reload|return|click|back)\b/i
          : /\b(riprova(?:re)?|attendi|consenti|controlla(?:lo|la|re)?|elimina(?:ne)?|scegli(?:ne)?|contatta|chiedi|usa|accedi|ricarica|torna|fai clic)\b/i;

      for (const f of failureTexts) {
        if (!nextStepPattern.test(f.text)) {
          missingNextStep.push(`${locale}.${f.key}: ${f.text}`);
        }
      }
    }
    expect(missingNextStep).toEqual([]);

    // Confirmation & consequence texts
    expect(en.site.database.databases.remove.body).toMatch(/(for good|permanent|lost|cannot be undone)/i);
    expect(itMsgs.site.database.databases.remove.body).toMatch(/(definitiv|persi|annullare|cancellat)/i);

    expect(en.site.database.users.grants.hint).toMatch(/(connection|close|immediately|stop)/i);
    expect(itMsgs.site.database.users.grants.hint).toMatch(/(connession|chius|immediatamente|smett)/i);

    expect(en.site.database.users.reset.body).toMatch(/(stop|immediately|update)/i);
    expect(itMsgs.site.database.users.reset.body).toMatch(/(smett|subito|aggiorna|immediatamente)/i);
  });
});
