import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { DNS_PROVIDER_FIELDS } from "@hosting-panel/contracts";
import type { DnsProviderSettingsDto } from "@hosting-panel/contracts";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";

const fetchUpstream = vi.fn();
vi.mock("@/lib/upstream", async () => ({
  ...(await vi.importActual<object>("@/lib/upstream")),
  fetchUpstream: (...a: unknown[]) => fetchUpstream(...a),
}));
vi.mock("@/lib/server-session", () => ({
  getSessionFromRequest: async () => ({ accessToken: "tok", csrfToken: "csrf" }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/admin/certificates" }));

import { GET, PATCH, DELETE } from "@/app/api/admin/dns-provider/route";
import { DnsProviderForm } from "@/components/admin/dns-provider-form";
import { SidebarNav } from "@/components/layout/sidebar-nav";
import { I18nProvider } from "@/i18n/provider";

const req = (method: string, headers: Record<string, string> = {}, body: unknown = {}) =>
  new Request("http://localhost:3000/x", {
    method,
    headers: { Host: "localhost:3000", Origin: "http://localhost:3000", "X-CSRF-Token": "csrf", "Content-Type": "application/json", ...headers },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });

const dto = (over: Partial<DnsProviderSettingsDto> = {}): DnsProviderSettingsDto => ({
  provider: "cloudflare",
  fieldsSet: ["CLOUDFLARE_DNS_API_TOKEN"],
  updatedAt: "2026-11-20T10:00:00Z",
  applied: true,
  ready: true,
  ...over,
});
const wrap = (m: typeof en, child: React.ReactElement) =>
  createElement(I18nProvider, { locale: m === en ? "en" : "it", messages: m, children: child });
const render = (m: typeof en, initial: DnsProviderSettingsDto) =>
  renderToStaticMarkup(wrap(m, createElement(DnsProviderForm, { csrfToken: "c", initial })));

describe("dns-provider BFF", () => {
  beforeEach(() => fetchUpstream.mockReset());

  it("dns-provider BFF forwards GET, PATCH and DELETE with CSRF", async () => {
    const bad = { "X-CSRF-Token": "bad" };
    expect((await PATCH(req("PATCH", bad, {}))).status).toBe(403);
    expect((await DELETE(req("DELETE", bad))).status).toBe(403);
    expect(fetchUpstream).not.toHaveBeenCalled();

    fetchUpstream.mockResolvedValue({ ok: true, status: 200, data: { data: {} } });
    await GET(req("GET"));
    await PATCH(req("PATCH", {}, { provider: "cloudflare" }));
    await DELETE(req("DELETE"));
    expect(fetchUpstream.mock.calls.map(([p, o]) => [p, o.method])).toEqual([
      ["v1/admin/dns-provider", "GET"],
      ["v1/admin/dns-provider", "PATCH"],
      ["v1/admin/dns-provider", "DELETE"],
    ]);
  });
});

describe("admin certificates page", () => {
  it("form never renders a stored credential", () => {
    for (const m of [en, itMsgs]) {
      const html = render(m, dto());
      expect(html).toContain("CLOUDFLARE_DNS_API_TOKEN");
      expect(html).toContain(m.admin.certificates.keep);
      expect(html).toContain(m.admin.certificates.fieldSet);
      expect(html).toContain(m.admin.certificates.ready);
      expect(html).not.toMatch(/<input[^>]*value="[^"]/);
    }
  });

  it("form lists the fields of the chosen provider", () => {
    const html = render(en, dto({ provider: "ovh", fieldsSet: [] }));
    const names = DNS_PROVIDER_FIELDS.ovh.map((f) => f.name);
    expect(names).toHaveLength(4);
    for (const n of names) expect(html).toContain(n);
    expect(html).toMatch(/id="dns-OVH_ENDPOINT"[^>]*type="text"|type="text"[^>]*id="dns-OVH_ENDPOINT"/);
    expect(html).not.toContain("CLOUDFLARE_DNS_API_TOKEN");
  });

  it("no provider shows the HTTP-01 notice", () => {
    for (const m of [en, itMsgs]) {
      const html = render(m, dto({ provider: null, fieldsSet: [], updatedAt: null, ready: null }));
      expect(html).toContain(m.admin.certificates.notConfigured);
      expect(html).toContain(m.admin.certificates.providerChoose);
      expect(html).not.toContain(m.admin.certificates.remove);
    }
  });

  it("sidebar links Certificates", () => {
    for (const m of [en, itMsgs]) {
      const html = renderToStaticMarkup(wrap(m, createElement(SidebarNav)));
      expect(html).toContain('href="/admin/certificates"');
      expect(html).toContain(m.admin.nav.certificates);
    }
  });
});

describe("certificates copy", () => {
  const leaves = (o: object, p = ""): [string, string][] =>
    Object.entries(o).flatMap(([k, v]) => (typeof v === "string" ? [[p + k, v] as [string, string]] : leaves(v, `${p}${k}.`)));

  it("certificates copy differs between IT and EN", () => {
    const { providers: _e, ...e } = en.admin.certificates;
    const { providers: _i, ...i } = itMsgs.admin.certificates;
    const le = leaves(e);
    const li = new Map(leaves(i));
    expect(le.map(([k]) => k).sort()).toEqual([...li.keys()].sort());
    for (const [k, v] of le) {
      expect(v, k).toBeTruthy();
      expect(v, k).not.toBe(li.get(k));
    }
  });
});
