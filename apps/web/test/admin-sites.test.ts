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
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/admin/users" }));

import { POST as createSite } from "@/app/api/admin/sites/route";
import { POST as changeOwner } from "@/app/api/admin/sites/[siteId]/owner/route";
import { DELETE as deleteSite } from "@/app/api/admin/sites/[siteId]/route";
import { SidebarNav } from "@/components/layout/sidebar-nav";
import { I18nProvider } from "@/i18n/provider";

const req = (method: string, headers: Record<string, string> = {}, body: unknown = {}) =>
  new Request("http://localhost:3000/x", {
    method,
    headers: { Host: "localhost:3000", Origin: "http://localhost:3000", "X-CSRF-Token": "csrf", ...headers },
    body: JSON.stringify(body),
  });
const site = { params: Promise.resolve({ siteId: "s1" }) };

describe("admin sites BFF", () => {
  beforeEach(() => fetchUpstream.mockReset());

  it("forwards create with ownerOrganizationId and an idempotency key", async () => {
    expect((await createSite(req("POST", {}, { name: "x" }))).status).toBe(400);
    fetchUpstream.mockResolvedValue({ ok: true, status: 202, data: { data: { siteId: "s1", operationId: "o1" } } });
    const res = await createSite(req("POST", { "Idempotency-Key": "k1" }, { name: "x", ownerOrganizationId: "org-1" }));
    expect(res.status).toBe(202);
    expect(fetchUpstream).toHaveBeenCalledWith(
      "v1/admin/sites",
      expect.objectContaining({ method: "POST", idempotencyKey: "k1", body: { name: "x", ownerOrganizationId: "org-1" } }),
    );
  });

  it("owner BFF forwards null for not assigned", async () => {
    fetchUpstream.mockResolvedValue({ ok: true, status: 202, data: {} });
    await changeOwner(req("POST", { "Idempotency-Key": "k2" }, { ownerOrganizationId: null }), site);
    expect(fetchUpstream).toHaveBeenCalledWith(
      "v1/admin/sites/s1/owner",
      expect.objectContaining({ idempotencyKey: "k2", body: { ownerOrganizationId: null } }),
    );
  });

  it("rejects a customer session", async () => {
    fetchUpstream.mockResolvedValue({ ok: false, status: 403, error: { error: { code: "PERMISSION_DENIED", message: "no" } } });
    expect((await deleteSite(req("DELETE", { "Idempotency-Key": "k3" }, { confirmName: "x" }), site)).status).toBe(403);
    expect((await createSite(req("POST", { "Idempotency-Key": "k3", "X-CSRF-Token": "bad" }, {}))).status).toBe(403);
  });
});

describe("admin sites UI", () => {
  it("sidebar lists Sites for server admins", () => {
    for (const [locale, m] of [["en", en], ["it", itMsgs]] as const) {
      const html = renderToStaticMarkup(createElement(I18nProvider, { locale, messages: m, children: createElement(SidebarNav) }));
      expect(html).toContain('href="/admin/sites"');
      expect(html).toContain(m.admin.nav.sites);
    }
  });

  it("owner confirmation copy names the consequence in both languages", () => {
    for (const m of [en, itMsgs]) {
      expect(m.admin.sites.moveTo).toContain("{owner}");
      expect(m.admin.sites.moveToNone.length).toBeGreaterThan(10);
    }
  });
});
