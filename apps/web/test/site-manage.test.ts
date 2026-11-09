import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";

const fetchUpstream = vi.fn();
vi.mock("@/lib/upstream", () => ({ fetchUpstream: (...a: unknown[]) => fetchUpstream(...a) }));
vi.mock("@/lib/server-session", () => ({
  getSessionFromRequest: async () => ({ accessToken: "tok", csrfToken: "csrf" }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/" }));

import { DELETE as deleteSite } from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/route";
import { PATCH as changeRuntime } from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/runtime/route";
import { GET as getLogs } from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/logs/route";
import { SITE_TABS } from "@/components/customer/site-tabs";
import { DeleteSiteForm } from "@/components/customer/delete-site-dialog";
import { Dialog } from "@/components/ui/dialog";
import { renewKeyAfter, showSetupProgress } from "@/lib/site-setup";
import { I18nProvider } from "@/i18n/provider";

const params = { params: Promise.resolve({ orgId: "org-1", siteId: "s1" }) };
const req = (method: string, url: string, headers: Record<string, string> = {}, body?: unknown) =>
  new Request(`http://localhost:3000${url}`, {
    method,
    headers: { Host: "localhost:3000", Origin: "http://localhost:3000", "X-CSRF-Token": "csrf", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("site management BFF", () => {
  beforeEach(() => fetchUpstream.mockReset());

  it("delete BFF forwards confirmName and requires CSRF", async () => {
    const noCsrf = req("DELETE", "/x", { "X-CSRF-Token": "bad", "Idempotency-Key": "k" }, { confirmName: "Hotel" });
    expect((await deleteSite(noCsrf, params)).status).toBe(403);
    expect(fetchUpstream).not.toHaveBeenCalled();

    fetchUpstream.mockResolvedValue({ ok: true, status: 202, data: {} });
    await deleteSite(req("DELETE", "/x", { "Idempotency-Key": "k" }, { confirmName: "Hotel" }), params);
    expect(fetchUpstream).toHaveBeenCalledWith(
      "v1/organizations/org-1/managed-sites/s1",
      expect.objectContaining({ method: "DELETE", idempotencyKey: "k", body: { confirmName: "Hotel" } }),
    );
  });

  it("runtime BFF rejects a PHP version outside the list before calling upstream", async () => {
    const bad = await changeRuntime(req("PATCH", "/x", { "Idempotency-Key": "k" }, { phpVersion: "5.6" }), params);
    expect(bad.status).toBe(400);
    expect(fetchUpstream).not.toHaveBeenCalled();

    fetchUpstream.mockResolvedValue({ ok: true, status: 202, data: {} });
    await changeRuntime(req("PATCH", "/x", { "Idempotency-Key": "k" }, { phpVersion: "8.5" }), params);
    expect(fetchUpstream).toHaveBeenCalledWith(
      "v1/organizations/org-1/managed-sites/s1/runtime",
      expect.objectContaining({ method: "PATCH", body: { phpVersion: "8.5" } }),
    );
  });

  it("logs BFF clamps tail and forwards", async () => {
    fetchUpstream.mockResolvedValue({ ok: true, status: 200, data: { data: [] } });
    const call = async (q: string) => {
      await getLogs(req("GET", `/x${q}`), params);
      return fetchUpstream.mock.calls.at(-1)![0];
    };
    expect(await call("")).toBe("v1/organizations/org-1/managed-sites/s1/logs?tail=200");
    expect(await call("?tail=9999")).toBe("v1/organizations/org-1/managed-sites/s1/logs?tail=500");
    expect(await call("?tail=0")).toBe("v1/organizations/org-1/managed-sites/s1/logs?tail=1");
    expect(await call("?tail=abc")).toBe("v1/organizations/org-1/managed-sites/s1/logs?tail=200");
  });
});

describe("site management UI", () => {
  it("SITE_TABS ends with logs", () => {
    expect(SITE_TABS.at(-1)!.key).toBe("logs");
    expect(SITE_TABS.at(-1)!.href("s1")).toBe("/sites/s1/logs");
  });

  it("setup progress shows only for a running setup or a failed one on a degraded site", () => {
    expect(showSetupProgress("deploying", "processing")).toBe(true);
    expect(showSetupProgress("deploying", "accepted")).toBe(true);
    expect(showSetupProgress("deploying", "succeeded")).toBe(false); // a restart or PHP change
    expect(showSetupProgress("deploying", undefined)).toBe(false);
    expect(showSetupProgress("degraded", "failed")).toBe(true);
    expect(showSetupProgress("degraded", "succeeded")).toBe(false);
    expect(showSetupProgress("ready", "failed")).toBe(false);
  });

  it("an idempotency key is renewed only after a 4xx", () => {
    expect([200, 202, 500, 502, 503].map(renewKeyAfter)).toEqual([false, false, false, false, false]);
    expect([400, 409, 422].map(renewKeyAfter)).toEqual([true, true, true]);
  });

  it("delete form names the site and keeps the button disabled until the name is typed", () => {
    for (const m of [en, itMsgs]) {
      const html = renderToStaticMarkup(
        createElement(I18nProvider, { locale: m === en ? "en" : "it", messages: m, children: createElement(Dialog, { open: true }, createElement(DeleteSiteForm, { siteName: "Hotel", onConfirm: async () => null, onCancel: () => {} })) }),
      );
      expect(html).toContain("<strong>Hotel</strong>");
      expect(html).toMatch(/<button[^>]*disabled[^>]*>[^<]*(Delete site|Elimina il sito)/);
    }
  });

  it("new copy has no infrastructure vocabulary", () => {
    const banned = /\b(container|image|docker|volume|network|revision|service|template|mariadb|job|organization|organizzazione|servizio)\b/i;
    for (const m of [en, itMsgs]) {
      expect(JSON.stringify([m.site.manage, m.site.logs, m.site.tabs])).not.toMatch(banned);
    }
  });
});
