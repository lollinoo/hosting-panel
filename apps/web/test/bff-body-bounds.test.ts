import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { encryptSession, SESSION_COOKIE_NAME } from "@/lib/session";
import { MAX_BFF_BODY_BYTES } from "@/lib/bff-proxy";
import { POST as postLogin } from "@/app/api/session/login/route";
import { POST as postOrgSites } from "@/app/api/bff/orgs/[orgId]/sites/route";
import { PUT as putFileContent } from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/files/content/route";
import { POST as postSiteBackup } from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/backups/route";
import { POST as postTlsImport } from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/tls-certificates/route";
import { POST as postTlsVersion } from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/tls-certificates/[certificateId]/versions/route";
import { POST as postAdminTlsImport } from "@/app/api/admin/sites/[siteId]/tls-certificates/route";
import { POST as postAdminTlsVersion } from "@/app/api/admin/sites/[siteId]/tls-certificates/[certificateId]/versions/route";
import { POST as postPhpMyAdmin } from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/databases/phpmyadmin/route";

const src = path.resolve(__dirname, "../src");

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? files(full) : /\.tsx?$/.test(e.name) ? [full] : [];
  });
}

// A body read is told from an upstream answer by its receiver: these names hold a fetch Response
// (or a picture the browser already holds), never the incoming request.
const UPSTREAM_READS: Record<string, string> = {
  "lib/upstream.ts:res": "the API's answer to fetchUpstream",
  "lib/keyed-send.ts:res": "the BFF's answer in the browser",
  "lib/admin-restart.ts:res": "the BFF's answer in the browser",
  "lib/terminal-session.ts:res": "the BFF's answer in the browser",
  "lib/file-browser.ts:res": "the BFF's answer in the browser",
  "lib/file-browser.ts:blob": "a file the customer picked in the browser, sliced into upload chunks",
};

// Bodies passed on as a stream, never read here; the receiving server bounds them.
const STREAM_PASS_THROUGH: Record<string, string> = {
  "lib/phpmyadmin-forwarder.ts": "phpMyAdmin's own forms and imports go on to its server as a stream (body: req.body)",
};

describe("web.3 (a): request bodies are read only through the bounded readers of bff-proxy.ts", () => {
  it("no route or helper calls a body reader on a request outside bff-proxy.ts", () => {
    const offenders: string[] = [];
    const used = new Set<string>();
    for (const file of [...files(path.join(src, "app/api")), ...files(path.join(src, "lib"))]) {
      const rel = path.relative(src, file).split(path.sep).join("/");
      if (rel === "lib/bff-proxy.ts") continue;
      const text = fs.readFileSync(file, "utf8");
      for (const m of text.matchAll(/\.\s*(json|text|arrayBuffer|formData|blob)\s*\(\s*\)/g)) {
        const receiver = /([\w$]*)\s*$/.exec(text.slice(0, m.index))?.[1] ?? "";
        const key = `${rel}:${receiver}`;
        if (receiver && UPSTREAM_READS[key]) used.add(key);
        else offenders.push(`${key} .${m[1]}()`);
      }
    }
    expect(offenders).toEqual([]);
    // Every allowance still names a real read, so the list cannot rot.
    expect([...used].sort()).toEqual(Object.keys(UPSTREAM_READS).sort());
    for (const rel of Object.keys(STREAM_PASS_THROUGH)) {
      expect(fs.readFileSync(path.join(src, rel), "utf8")).toContain("body: req.body");
    }
  });
});

const CHUNK = 64 * 1024;
const GUARD = 16 * MAX_BFF_BODY_BYTES;

// A body that never ends: counts what was pulled and whether the reader cancelled it.
function endlessBody() {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        // Only a reader that drains everything gets here; it keeps a red run finite.
        if (state.pulled >= GUARD) {
          controller.error(new Error("drained"));
          return;
        }
        state.pulled += CHUNK;
        controller.enqueue(new Uint8Array(CHUNK).fill(0x20));
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, state };
}

describe("web.3 (b): a body that never ends is refused and its read stops at the limit", () => {
  const fetchSpy = vi.fn(async () => new Response("{}", { status: 500 }));
  let cookie = "";
  const csrf = "csrf-sentinel-value";

  beforeAll(async () => {
    const token = await encryptSession({
      accessToken: "sentinel-access-token",
      csrfToken: csrf,
      activeConsole: "customer",
      activeOrgSlug: "org-a",
      user: {
        id: "user_1",
        email: "owner@example.test",
        name: "Owner",
        globalRoles: [],
        hostingAdminOrgIds: [],
        locale: "en",
        isServerAdmin: false,
        mustChangePassword: false,
      },
    });
    cookie = `${SESSION_COOKIE_NAME}=${token}`;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchSpy.mockClear();
  });

  function request(url: string, method: string, stream: ReadableStream<Uint8Array>, withSession: boolean) {
    const headers: Record<string, string> = { Host: "localhost:3000", "Content-Type": "application/json" };
    if (withSession) {
      Object.assign(headers, { Origin: "http://localhost:3000", Cookie: cookie, "X-CSRF-Token": csrf, "Idempotency-Key": "idem-sentinel-1" });
    }
    return new Request(`http://localhost:3000${url}`, { method, headers, body: stream, duplex: "half" } as RequestInit);
  }

  const siteCtx = { params: Promise.resolve({ orgId: "org_1", siteId: "site_1" }) };
  const cases: Array<{ name: string; cap: number; call: (s: ReadableStream<Uint8Array>) => Promise<Response> }> = [
    { name: "sign-in", cap: MAX_BFF_BODY_BYTES, call: (s) => postLogin(request("/api/session/login", "POST", s, false)) },
    {
      name: "generic site create (readBoundedJsonBody)",
      cap: MAX_BFF_BODY_BYTES,
      call: (s) =>
        postOrgSites(request("/api/bff/orgs/org_1/sites", "POST", s, true), {
          params: Promise.resolve({ orgId: "org_1" }),
        }),
    },
    {
      name: "file upload chunk (forwardSiteCall)",
      cap: MAX_BFF_BODY_BYTES,
      call: (s) => putFileContent(request("/api/bff/orgs/org_1/managed-sites/site_1/files/content", "PUT", s, true), siteCtx),
    },
    {
      name: "site backup (readBoundedText)",
      cap: MAX_BFF_BODY_BYTES,
      call: (s) => postSiteBackup(request("/api/bff/orgs/org_1/managed-sites/site_1/backups", "POST", s, true), siteCtx),
    },
    {
      name: "TLS certificate import (forwardSiteCall, private key in the body)",
      cap: MAX_BFF_BODY_BYTES,
      call: (s) => postTlsImport(request("/api/bff/orgs/org_1/managed-sites/site_1/tls-certificates", "POST", s, true), siteCtx),
    },
    {
      name: "TLS certificate new version (forwardSiteCall)",
      cap: MAX_BFF_BODY_BYTES,
      call: (s) =>
        postTlsVersion(
          request("/api/bff/orgs/org_1/managed-sites/site_1/tls-certificates/cert_1/versions", "POST", s, true),
          { params: Promise.resolve({ orgId: "org_1", siteId: "site_1", certificateId: "cert_1" }) },
        ),
    },
    {
      name: "admin TLS certificate import (forwardIdempotent)",
      cap: MAX_BFF_BODY_BYTES,
      call: (s) =>
        postAdminTlsImport(request("/api/admin/sites/site_1/tls-certificates", "POST", s, true), {
          params: Promise.resolve({ siteId: "site_1" }),
        }),
    },
    {
      name: "admin TLS certificate new version (forwardIdempotent)",
      cap: MAX_BFF_BODY_BYTES,
      call: (s) =>
        postAdminTlsVersion(request("/api/admin/sites/site_1/tls-certificates/cert_1/versions", "POST", s, true), {
          params: Promise.resolve({ siteId: "site_1", certificateId: "cert_1" }),
        }),
    },
    {
      name: "phpMyAdmin sign-on (readBoundedText, 4 KiB)",
      cap: 4096,
      call: (s) =>
        postPhpMyAdmin(request("/api/bff/orgs/org_1/managed-sites/site_1/databases/phpmyadmin", "POST", s, true), siteCtx),
    },
  ];

  for (const c of cases) {
    it(`${c.name}: 413, the stream is cancelled after about the limit, nothing reaches the API`, async () => {
      vi.stubGlobal("fetch", fetchSpy);
      const { stream, state } = endlessBody();
      const res = await c.call(stream);
      expect(res.status).toBe(413);
      expect(state.cancelled).toBe(true);
      expect(state.pulled).toBeLessThanOrEqual(c.cap + CHUNK);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }
});
