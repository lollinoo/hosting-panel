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

import { POST as createSite } from "@/app/api/bff/orgs/[orgId]/managed-sites/route";
import { POST as siteAction } from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/actions/route";
import { EmptySites } from "@/components/customer/empty-sites";

const request = (url: string, headers: Record<string, string> = {}) =>
  new Request(`http://localhost:3000${url}`, {
    method: "POST",
    headers: { Host: "localhost:3000", Origin: "http://localhost:3000", "X-CSRF-Token": "csrf", ...headers },
    body: JSON.stringify({ name: "Hotel" }),
  });

describe("managed-sites BFF", () => {
  beforeEach(() => fetchUpstream.mockReset());

  it("requires an idempotency key and forwards to the API", async () => {
    const params = { params: Promise.resolve({ orgId: "org-1" }) };
    expect((await createSite(request("/api/bff/orgs/org-1/managed-sites"), params)).status).toBe(400);
    expect(fetchUpstream).not.toHaveBeenCalled();

    fetchUpstream.mockResolvedValue({ ok: true, status: 202, data: { data: { siteId: "s1", operationId: "o1" } } });
    const res = await createSite(request("/api/bff/orgs/org-1/managed-sites", { "Idempotency-Key": "k1" }), params);
    expect(res.status).toBe(202);
    expect(fetchUpstream).toHaveBeenCalledWith(
      "v1/organizations/org-1/managed-sites",
      expect.objectContaining({ method: "POST", idempotencyKey: "k1", accessToken: "tok" }),
    );
  });

  it("forwards site actions with the same key", async () => {
    fetchUpstream.mockResolvedValue({ ok: true, status: 202, data: {} });
    const params = { params: Promise.resolve({ orgId: "org-1", siteId: "s1" }) };
    await siteAction(request("/x", { "Idempotency-Key": "k2" }), params);
    expect(fetchUpstream).toHaveBeenCalledWith(
      "v1/organizations/org-1/managed-sites/s1/actions",
      expect.objectContaining({ idempotencyKey: "k2" }),
    );
  });
});

describe("create-site UI", () => {
  it("empty state links to /sites/new", () => {
    for (const m of [en, itMsgs]) {
      expect(renderToStaticMarkup(createElement(EmptySites, { m }))).toContain('href="/sites/new"');
    }
  });

  it("new customer copy has no infrastructure vocabulary", () => {
    const banned = /\b(container|image|docker|volume|network|revision|service|template|mariadb|job|organization|organizzazione|servizio)\b/i;
    for (const m of [en, itMsgs]) {
      const copy = JSON.stringify([m.site.create, m.site.progress, m.site.wpAdmin, m.shell.emptyTitle, m.shell.emptyBody, m.shell.emptyCta, m.shell.newSite]);
      expect(copy).not.toMatch(banned);
    }
  });
});
