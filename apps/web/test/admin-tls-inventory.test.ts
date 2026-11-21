import { beforeEach, describe, expect, it, vi } from "vitest";
import { Children, cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  AdminTlsInventoryItemDto,
  SiteDomainDto,
  TlsCertificateAlertDto,
  TlsCertificateDto,
} from "@hosting-panel/contracts";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";

const fetchUpstream = vi.fn();
vi.mock("@/lib/upstream", () => ({ fetchUpstream: (...a: unknown[]) => fetchUpstream(...a) }));
vi.mock("@/lib/server-session", () => ({
  getServerSession: async () => ({ accessToken: "tok", csrfToken: "csrf" }),
  getSessionFromRequest: async () => ({ accessToken: "tok", csrfToken: "csrf" }),
}));
vi.mock("@/i18n/server", () => ({ getRequestLocale: async () => "en" }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/admin/certificates",
}));

import AdminCertificatesPage from "@/app/admin/certificates/page";
import { CertificateInventory } from "@/components/admin/certificate-inventory";
import { TlsAlerts } from "@/components/admin/tls-alerts";
import { alertLink } from "@/lib/admin-alerts";
import { I18nProvider } from "@/i18n/provider";

const NOW = "2026-11-21T12:00:00.000Z";
const days = (n: number) => new Date(Date.parse(NOW) + n * 86_400_000).toISOString();
const wrap = (m: typeof en, child: ReactElement) =>
  createElement(I18nProvider, { locale: m === en ? "en" : "it", messages: m, children: child });
const html = (child: ReactElement, m: typeof en = en) => renderToStaticMarkup(wrap(m, child));
const esc = (s: string) => s.replace(/'/g, "&#x27;");

const manualRow = (over: Partial<AdminTlsInventoryItemDto> = {}): AdminTlsInventoryItemDto => ({
  source: "manual",
  certificateId: "cti_" + "a".repeat(32),
  name: "Shop certificate",
  organizationId: "org_1",
  organizationName: "Acme",
  siteId: "site_1",
  siteName: "Shop",
  hostnames: ["shop.example.com", "www.example.com"],
  issuer: "Example CA",
  wildcard: false,
  notAfter: days(10),
  status: "active",
  tier: "warning",
  ...over,
});
const acmeRow = (over: Partial<AdminTlsInventoryItemDto> = {}): AdminTlsInventoryItemDto => ({
  source: "acme",
  certificateId: null,
  name: null,
  organizationId: "org_2",
  organizationName: "Beta",
  siteId: "site_2",
  siteName: "Blog",
  hostnames: ["blog.example.org"],
  issuer: "Let's Encrypt",
  wildcard: false,
  notAfter: days(80),
  status: "active",
  tier: "ok",
  ...over,
});

const cert = (): TlsCertificateDto =>
  ({
    id: "cti_" + "a".repeat(32),
    name: "Shop certificate",
    source: "manual",
    createdForSiteId: "site_1",
    activeVersionId: "ctv_" + "b".repeat(32),
    versions: [
      {
        id: "ctv_" + "b".repeat(32),
        versionNumber: 1,
        status: "active",
        subject: "shop.example.com",
        issuer: "Example CA",
        sanDns: ["shop.example.com", "*.shop.example.com"],
        wildcard: true,
        notBefore: days(-300),
        notAfter: days(10),
        serialNumber: "0A1B2C",
        fingerprintSha256: "f".repeat(64),
        keyType: "ec",
        keyBits: 256,
        createdAt: days(-300),
        activatedAt: days(-299),
        problem: null,
      },
    ],
    coveredDomains: [],
  }) as unknown as TlsCertificateDto;

const baseProps = {
  items: [manualRow(), acmeRow()],
  sites: [
    { id: "site_1", name: "Shop", owner: "Acme" },
    { id: "site_2", name: "Blog", owner: "Beta" },
  ],
  siteId: null as string | null,
  domains: [] as SiteDomainDto[],
  certificates: [] as TlsCertificateDto[],
  query: { filter: "all" as const, q: "" },
  manualAvailable: true,
  csrfToken: "csrf",
  now: NOW,
};
const inventory = (over: Record<string, unknown> = {}, m: typeof en = en) =>
  html(createElement(CertificateInventory, { ...baseProps, ...over } as never), m);

describe("admin certificates page", () => {
  beforeEach(() => {
    fetchUpstream.mockReset();
    fetchUpstream.mockImplementation(async (path: string) => {
      const ok = (data: unknown) => ({ ok: true, status: 200, data: { data } });
      if (path.startsWith("v1/admin/tls-certificates/alerts")) return ok([]);
      if (path.startsWith("v1/admin/tls-certificates")) return ok([manualRow()]);
      if (path === "v1/admin/dns-provider") return ok({ provider: null, fieldsSet: [], updatedAt: null, applied: true, ready: false });
      if (path === "v1/admin/sites") return ok({ sites: [], customers: [], certificateAlerts: [] });
      if (path === "v1/me") return ok({ platformCapabilities: { manualTlsCertificatesAvailable: true } });
      return { ok: false, status: 404 };
    });
  });
  // The page nests one async server component; React's static renderer cannot await it, so it is resolved here.
  const expand = async (node: ReactNode): Promise<ReactNode> => {
    if (!isValidElement(node)) return node;
    const el = node as ReactElement<{ children?: ReactNode }>;
    if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") {
      return expand(await (el.type as (p: unknown) => Promise<ReactNode>)(el.props));
    }
    if (el.props.children === undefined || typeof el.type === "function") return el;
    return cloneElement(el, undefined, ...(await Promise.all(Children.toArray(el.props.children).map(expand))));
  };
  const render = async (sp: Record<string, string | string[] | undefined>) =>
    html((await expand(await AdminCertificatesPage({ searchParams: Promise.resolve(sp) }))) as ReactElement);
  const inventoryPaths = () =>
    fetchUpstream.mock.calls.map(([p]) => p as string).filter((p) => p.startsWith("v1/admin/tls-certificates") && !p.includes("/alerts"));

  it("asks the API for the whitelisted filter and the search text", async () => {
    await render({ filter: "expired", q: "shop" });
    expect(inventoryPaths()).toEqual(["v1/admin/tls-certificates?filter=expired&q=shop"]);
  });

  it("falls back to filter=all for an unknown filter and encodes q", async () => {
    await render({ filter: "bogus", q: "a&b=c d" });
    expect(inventoryPaths()).toEqual(["v1/admin/tls-certificates?filter=all&q=a%26b%3Dc+d"]);
  });

  it("keeps the DNS provider form below the inventory", async () => {
    const out = await render({});
    expect(out).toContain(en.admin.certificates.inventory.title);
    expect(out.indexOf(en.admin.certificates.inventory.title)).toBeLessThan(out.indexOf(en.admin.certificates.providerChoose));
  });

  it("shows an error alert instead of an empty table when the list cannot be loaded", async () => {
    fetchUpstream.mockImplementation(async (path: string) =>
      path.startsWith("v1/admin/tls-certificates") && !path.includes("/alerts")
        ? { ok: false, status: 500 }
        : { ok: true, status: 200, data: { data: [] } },
    );
    const out = await render({});
    expect(out).toContain(en.admin.certificates.inventory.unavailable);
    expect(out).not.toContain(en.admin.certificates.inventory.empty);
  });

  it("loads the chosen site's domains and certificates only for a known site", async () => {
    fetchUpstream.mockImplementation(async (path: string) => {
      const ok = (data: unknown) => ({ ok: true, status: 200, data: { data } });
      if (path.includes("/alerts")) return ok([]);
      if (path.startsWith("v1/admin/tls-certificates")) return ok([]);
      if (path === "v1/admin/sites") {
        return ok({
          sites: [{ id: "site_1", name: "Shop", owner: { organizationId: "o", name: "Acme" } }],
          customers: [],
          certificateAlerts: [],
        });
      }
      if (path === "v1/me") return ok({ platformCapabilities: { manualTlsCertificatesAvailable: true } });
      if (path === "v1/admin/sites/site_1/domains") return ok({ domains: [] });
      if (path === "v1/admin/sites/site_1/tls-certificates") return ok([cert()]);
      return ok(null);
    });
    await render({ site: "site_1" });
    const paths = fetchUpstream.mock.calls.map(([p]) => p);
    expect(paths).toContain("v1/admin/sites/site_1/domains");
    expect(paths).toContain("v1/admin/sites/site_1/tls-certificates");
    fetchUpstream.mockClear();
    await render({ site: "site_unknown" });
    expect(fetchUpstream.mock.calls.map(([p]) => p)).not.toContain("v1/admin/sites/site_unknown/domains");
  });
});

describe("CertificateInventory", () => {
  it("renders source, hostnames, issuer, wildcard and the expiry tier as text with an icon", () => {
    const out = inventory();
    const t = en.admin.certificates.inventory;
    expect(out).toContain(t.source.manual);
    expect(out).toContain(esc(t.source.acme));
    expect(out).toContain("shop.example.com");
    expect(out).toContain("Example CA");
    expect(out).toContain(t.wildcard.no);
    expect(out).toContain("Expires in 10 days");
    expect(out).toContain("Valid until");
    expect(out).toContain(t.state.active);
    expect(out).toMatch(/<svg[^>]*aria-hidden="true"/);
  });

  it("marks an expired certificate in words and shows the wildcard flag", () => {
    const out = inventory({ items: [manualRow({ notAfter: days(-3), tier: "expired", wildcard: true, status: "failed" })] });
    expect(out).toContain("Expired on");
    expect(out).toContain(en.admin.certificates.inventory.wildcard.yes);
    expect(out).toContain(en.admin.certificates.inventory.state.failed);
  });

  it("shows the 30-day notice as a row badge", () => {
    expect(inventory({ items: [manualRow({ notAfter: days(25), tier: "notice" })] })).toContain("Expires in 25 days");
  });

  it("says when the end date is not known yet", () => {
    const out = inventory({ items: [acmeRow({ notAfter: null, tier: null, status: "requested" })] });
    expect(out).toContain(en.admin.certificates.inventory.expiry.unknown);
    expect(out).toContain(en.admin.certificates.inventory.state.requested);
  });

  it("expands each row with its hosts linking to the site's domains, plus versions when known", () => {
    const out = inventory({ siteId: "site_1", certificates: [cert()] });
    expect(out.match(/<details/g)).toHaveLength(2);
    expect(out).toContain(en.admin.certificates.inventory.details.summary);
    expect(out).toContain('href="/admin/sites/site_1/domains"');
    expect(out).toContain('href="/admin/sites/site_2/domains"');
    expect(out).toContain("f".repeat(64));
    expect(out).toContain("0A1B2C");
    expect(out).toContain("*.shop.example.com");
    expect(out).toContain("EC 256");
  });

  it("does not invent fingerprints for a certificate it has no detail for", () => {
    const out = inventory();
    expect(out).not.toContain(en.admin.certificates.inventory.details.fingerprint);
    expect(out).toContain(en.admin.certificates.inventory.details.hosts);
  });

  it("never prints key material", () => {
    expect(inventory({ siteId: "site_1", certificates: [cert()] })).not.toMatch(/BEGIN|PRIVATE KEY/);
  });

  it("shows the empty text", () => {
    expect(inventory({ items: [] })).toContain(en.admin.certificates.inventory.empty);
  });

  it("filter links keep q and site, and mark the active filter with aria-current", () => {
    const out = inventory({ query: { filter: "expiring", q: "shop" }, siteId: "site_1" });
    const nav = out.slice(out.indexOf("<nav"), out.indexOf("</nav>"));
    expect(nav.match(/aria-current="page"/g)).toHaveLength(1);
    const active = nav.match(/<a[^>]*aria-current="page"[^>]*>/)![0];
    expect(active).toContain("filter=expiring");
    for (const f of ["manual", "automatic", "expired"]) expect(nav).toContain(`filter=${f}`);
    expect(nav).toContain('href="/admin/certificates?q=shop&amp;site=site_1"');
    expect(nav).toContain("q=shop");
    expect(nav).toContain("site=site_1");
  });

  it("has a GET search form that works without scripts and keeps the filter", () => {
    const out = inventory({ query: { filter: "manual", q: "shop" } });
    const form = out.match(/<form[^>]*>[^]*?<\/form>/)![0];
    expect(form).toContain('method="get"');
    expect(form).toContain('action="/admin/certificates"');
    expect(form).toContain('name="q"');
    expect(form).toContain('value="shop"');
    expect(form).toMatch(/<input[^>]*type="hidden"[^>]*name="filter"[^>]*value="manual"|<input[^>]*name="filter"[^>]*type="hidden"[^>]*value="manual"/);
    expect(form).toContain('name="site"');
  });

  it("disables Import until a site is chosen", () => {
    const out = inventory();
    const btn = out.match(/<button[^>]*>[^<]*Import a certificate for the chosen site<\/button>/)![0];
    expect(btn).toContain('disabled=""');
    expect(out).toContain(esc(en.admin.certificates.inventory.importHint));
  });

  it("enables Import once a site is chosen and the capability is on", () => {
    const out = inventory({ siteId: "site_1" });
    const btn = out.match(/<button[^>]*>[^<]*Import a certificate for the chosen site<\/button>/)![0];
    expect(btn).not.toContain('disabled=""');
    expect(out).toContain('<option value="site_1" selected="">');
  });

  it("keeps Import disabled and explains why when the capability is off", () => {
    const out = inventory({ siteId: "site_1", manualAvailable: false });
    const btn = out.match(/<button[^>]*>[^<]*Import a certificate for the chosen site<\/button>/)![0];
    expect(btn).toContain('disabled=""');
    expect(out).toContain(esc(en.admin.certificates.inventory.importUnavailable));
  });

  it("does not mount the wizard until Import is pressed", () => {
    expect(inventory({ siteId: "site_1" })).not.toContain('role="dialog"');
  });

  it("renders in Italian with different words", () => {
    const out = inventory({ siteId: "site_1" }, itMsgs as unknown as typeof en);
    expect(out).toContain(itMsgs.admin.certificates.inventory.source.manual);
    expect(itMsgs.admin.certificates.inventory.source.manual).not.toBe(en.admin.certificates.inventory.source.manual);
  });
});

describe("TlsAlerts", () => {
  const alert = (over: Partial<TlsCertificateAlertDto> = {}): TlsCertificateAlertDto => ({
    certificateId: "cti_" + "a".repeat(32),
    certificateName: "Shop certificate",
    versionId: "ctv_" + "b".repeat(32),
    organizationId: "org_1",
    siteId: "site_1",
    siteName: "Shop",
    hostnames: ["shop.example.com"],
    notAfter: days(5),
    tier: "critical",
    daysLeft: 5,
    ...over,
  });
  const alerts = (list: TlsCertificateAlertDto[] | null) => html(createElement(TlsAlerts, { alerts: list }));

  it("lists warning, critical and expired alerts with name, site and a link to the expiring filter", () => {
    const out = alerts([alert(), alert({ tier: "warning", certificateName: "Blog cert", siteName: null, siteId: null }), alert({ tier: "expired", certificateName: "Old cert" })]);
    expect(out).toContain('role="alert"');
    expect(out.match(/<li/g)).toHaveLength(3);
    expect(out).toContain("Shop certificate");
    expect(out).toContain("Blog cert");
    expect(out).toContain(en.admin.certificates.inventory.alerts.noSite);
    expect(out).toContain("import a renewed certificate now");
    expect(out).toContain('href="/admin/certificates?filter=expiring"');
  });

  it("never lists the 30-day notice", () => {
    const out = alerts([{ ...alert(), tier: "notice" } as unknown as TlsCertificateAlertDto]);
    expect(out).toBe("");
  });

  it("renders nothing without alerts or when they could not be loaded", () => {
    expect(alerts([])).toBe("");
    expect(alerts(null)).toBe("");
  });

  it("points the health alert to the expiring filter", () => {
    expect(
      alertLink({
        kind: "manual_certificate_expiring",
        severity: "warning",
        details: { siteId: null, siteName: null, certificateId: "c", certificateName: "n", notAfter: days(5), tier: "critical" },
      } as never),
    ).toEqual({ href: "/admin/certificates?filter=expiring", label: "openCertificates" });
  });
});
