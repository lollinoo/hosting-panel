import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import {
  DNS_PROVIDERS,
  DNS_PROVIDER_FIELDS,
  dnsCredentialIssues,
  type DnsFieldMessage,
  type DnsProvider,
  type DnsProviderSettingsDto,
  type SiteDomainDto,
  type SiteDomainsDto,
} from "@hosting-panel/contracts";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";

// A tiny hook runtime so the client components can be driven without a DOM: when `h.on`, useState/useRef/useEffect
// keep their slots in `h`; otherwise everything delegates to React (renderToStaticMarkup works as usual).
const h = vi.hoisted(() => ({
  on: false,
  i: 0,
  slots: {} as Record<number, unknown>,
  effects: [] as (() => unknown)[],
  messages: null as unknown,
  session: { accessToken: "tok", csrfToken: "csrf" } as { accessToken: string; csrfToken: string } | null,
}));
vi.mock("react", async () => {
  const a = await vi.importActual<typeof import("react")>("react");
  return {
    ...a,
    default: a,
    useState: (init: unknown) => {
      if (!h.on) return a.useState(init);
      const n = h.i++;
      if (!(n in h.slots)) h.slots[n] = typeof init === "function" ? (init as () => unknown)() : init;
      return [h.slots[n], (v: unknown) => (h.slots[n] = typeof v === "function" ? (v as (p: unknown) => unknown)(h.slots[n]) : v)];
    },
    useRef: (init: unknown) => {
      if (!h.on) return a.useRef(init);
      const n = h.i++;
      if (!(n in h.slots)) h.slots[n] = { current: init };
      return h.slots[n];
    },
    useEffect: (fn: import("react").EffectCallback, deps?: unknown[]) => (h.on ? void h.effects.push(fn) : a.useEffect(fn, deps)),
  };
});
vi.mock("@/i18n/provider", async () => {
  const a = await vi.importActual<typeof import("@/i18n/provider")>("@/i18n/provider");
  return { ...a, useMessages: () => (h.on ? h.messages : a.useMessages()), useLocale: () => (h.on ? "en" : a.useLocale()) } as typeof a;
});

const fetchUpstream = vi.fn();
vi.mock("@/lib/upstream", async () => ({
  ...(await vi.importActual<object>("@/lib/upstream")),
  fetchUpstream: (...a: unknown[]) => fetchUpstream(...a),
}));
vi.mock("@/lib/server-session", () => ({
  getSessionFromRequest: async () => h.session,
  getServerSession: async () => (h.session ? { ...h.session, user: { isServerAdmin: true } } : null),
}));
const fetchServerAdminDnsProvider = vi.fn();
const fetchServerAdminSiteDomains = vi.fn();
vi.mock("@/lib/server-api", () => ({
  fetchServerAdminDnsProvider: () => fetchServerAdminDnsProvider(),
  fetchServerAdminSiteDomains: () => fetchServerAdminSiteDomains(),
}));
vi.mock("@/i18n/server", () => ({ getRequestLocale: async () => "en" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/admin/certificates",
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

import { GET, PATCH, DELETE } from "@/app/api/admin/dns-provider/route";
import { PATCH as setChallenge } from "@/app/api/admin/sites/[siteId]/domains/[domainId]/route";
import AdminCertificatesPage from "@/app/admin/certificates/page";
import AdminSiteDomainsPage from "@/app/admin/sites/[siteId]/domains/page";
import { DnsProviderForm } from "@/components/admin/dns-provider-form";
import { DomainsPanel } from "@/components/customer/domains-panel";
import { I18nProvider } from "@/i18n/provider";

// ---------- helpers ----------

const req = (method: string, headers: Record<string, string> = {}, body?: unknown, raw?: string) =>
  new Request("http://localhost:3000/x", {
    method,
    headers: { Host: "localhost:3000", Origin: "http://localhost:3000", "X-CSRF-Token": "csrf", "Content-Type": "application/json", ...headers },
    body: method === "GET" ? undefined : (raw ?? JSON.stringify(body ?? {})),
  });
const dp = { params: Promise.resolve({ siteId: "s1", domainId: "d1" }) };

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
const markup = (m: typeof en, child: React.ReactElement) => renderToStaticMarkup(wrap(m, child)).replaceAll("&#x27;", "'");

const dom = (hostname: string, challenge: SiteDomainDto["challenge"] = "http-01"): SiteDomainDto => ({
  id: hostname,
  hostname,
  isPrimary: hostname === "hotel.it",
  routed: true,
  challenge,
  dns: { status: "ok", checkedAt: null, nextCheckAt: "2026-11-09T13:00:00Z", observedA: [], observedAaaa: [] },
  certificate: { status: "active", problem: null, expiresAt: "2099-01-01T00:00:00Z", retryAt: null, trusted: true },
  tls: { mode: "acme", certificateId: null, versionId: null, state: null, problem: null },
});
const domains = (...d: SiteDomainDto[]): SiteDomainsDto => ({
  serverIpv4: "203.0.113.10",
  routesPending: false,
  domains: d,
  mail: { configured: false, fromAddress: null },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = { type: unknown; props: Record<string, any> };
const find = (node: unknown, pred: (n: N) => boolean, out: N[] = []): N[] => {
  if (Array.isArray(node)) node.forEach((c) => find(c, pred, out));
  else if (node && typeof node === "object" && "props" in node) {
    const n = node as N;
    if (pred(n)) out.push(n);
    find(n.props.children, pred, out);
  }
  return out;
};
const text = (node: unknown): string =>
  Array.isArray(node) ? node.map(text).join("") : typeof node === "string" || typeof node === "number" ? String(node) : node && typeof node === "object" && "props" in node ? text((node as N).props.children) : "";
const byId = (tree: unknown, id: string) => find(tree, (n) => n.props.id === id)[0];
const alerts = (tree: unknown) => find(tree, (n) => n.props.role === "alert").map(text);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** Calls the component function directly with the hook runtime on; `render()` re-runs it with the state so far. */
function mount<P>(component: (p: P) => unknown, props: P) {
  h.on = true;
  h.slots = {};
  h.messages = en;
  const render = () => {
    h.i = 0;
    h.effects = [];
    return component(props);
  };
  return { render };
}

afterEach(() => {
  h.on = false;
  h.session = { accessToken: "tok", csrfToken: "csrf" };
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------- (1) catalog parity ----------

describe("DNS-01 catalog parity", () => {
  const messageKeys = (): DnsFieldMessage[] => {
    // Probes that make the contract emit every message key; a new key in the contract that the probes miss is a test gap, not a pass.
    const seen = new Set<DnsFieldMessage>();
    const probe = (p: DnsProvider, c: Record<string, string>, all = false) => dnsCredentialIssues(p, c, all).forEach((i) => seen.add(i.message));
    probe("cloudflare", {}, true);
    probe("cloudflare", { NOPE: "x" });
    probe("cloudflare", { CLOUDFLARE_DNS_API_TOKEN: "" });
    probe("httpreq", { HTTPREQ_ENDPOINT: "ftp://x" });
    probe("httpreq", { HTTPREQ_USERNAME: "u" }, true);
    probe("ovh", { OVH_ENDPOINT: "ovh-moon" });
    // Compile-time guard: adding a DnsFieldMessage without listing it here fails the typecheck.
    const all = { field_required: 1, field_unknown: 1, value_invalid: 1, endpoint_invalid: 1, ovh_endpoint_invalid: 1, credentials_pair: 1 } satisfies Record<DnsFieldMessage, 1>;
    expect([...seen].sort()).toEqual(Object.keys(all).sort());
    return [...seen];
  };

  it("every provider, field name and zod message has a label in IT and EN, and the catalogs have no stale entries", () => {
    const keys = messageKeys();
    for (const m of [en, itMsgs]) {
      const c = m.admin.certificates;
      expect(Object.keys(c.providers).sort()).toEqual([...DNS_PROVIDERS].sort());
      for (const p of DNS_PROVIDERS) expect(c.providers[p], p).toBeTruthy();
      expect(Object.keys(c.field).sort()).toEqual([...keys].sort());
      for (const k of keys) expect(c.field[k], k).toBeTruthy();
    }
  });

  it("every provider field renders as its own name in the form, in IT and EN", () => {
    for (const m of [en, itMsgs]) {
      for (const p of DNS_PROVIDERS) {
        const html = markup(m, createElement(DnsProviderForm, { csrfToken: "c", initial: dto({ provider: p, fieldsSet: [] }) }));
        expect(html, p).toContain(m.admin.certificates.providers[p]);
        for (const f of DNS_PROVIDER_FIELDS[p]) {
          expect(html, f.name).toContain(`id="dns-${f.name}"`);
          expect(html.includes(m.admin.certificates.optional), f.name).toBe(DNS_PROVIDER_FIELDS[p].some((x) => !x.required));
        }
      }
    }
  });

  it("the challenge control copy exists in IT and EN", () => {
    for (const m of [en, itMsgs]) {
      for (const k of ["label", "http-01", "dns-01", "noProvider"] as const) expect(m.admin.sites.challenge[k], k).toBeTruthy();
      for (const k of ["http-01", "dns-01"] as const) expect(m.site.domains.challenge[k], k).toBeTruthy();
    }
    expect(en.admin.sites.challenge.noProvider).not.toBe(itMsgs.admin.sites.challenge.noProvider);
    expect(en.site.domains.challenge["dns-01"]).not.toBe(itMsgs.site.domains.challenge["dns-01"]);
  });
});

// ---------- (2) write-only form ----------

describe("DNS provider form is write-only", () => {
  it("never prints a stored value: every input is empty, secrets are password inputs, endpoints text", () => {
    for (const m of [en, itMsgs]) {
      for (const p of DNS_PROVIDERS) {
        const fieldsSet = DNS_PROVIDER_FIELDS[p].map((f) => f.name);
        const html = markup(m, createElement(DnsProviderForm, { csrfToken: "c", initial: dto({ provider: p, fieldsSet }) }));
        for (const f of fieldsSet) {
          const input = html.match(new RegExp(`<input[^>]*id="dns-${f}"[^>]*>`))?.[0] ?? "";
          expect(input, f).toContain(f.endsWith("_ENDPOINT") ? 'type="text"' : 'type="password"');
          expect(input, f).toContain('value=""');
          expect(input, f).toContain(`placeholder="${m.admin.certificates.keep}"`);
          expect(input, f).toContain('autoComplete="new-password"');
        }
        expect(html.split(`>${m.admin.certificates.fieldSet}</div>`).length - 1, p).toBe(fieldsSet.length);
      }
    }
  });

  it("marks only the fields that are stored", () => {
    const html = markup(en, createElement(DnsProviderForm, { csrfToken: "c", initial: dto({ provider: "ovh", fieldsSet: ["OVH_APPLICATION_KEY"] }) }));
    expect(html.split(`>${en.admin.certificates.fieldSet}</div>`).length - 1).toBe(1);
    expect(html.split(`placeholder="${en.admin.certificates.keep}"`).length - 1).toBe(1);
  });

  it("shows the right status for each applied/ready state", () => {
    const status = (over: Partial<DnsProviderSettingsDto>) => markup(en, createElement(DnsProviderForm, { csrfToken: "c", initial: dto(over) }));
    expect(status({ applied: false, ready: null })).toContain(en.admin.certificates.applying);
    expect(status({ ready: false })).toContain(en.admin.certificates.notReady);
    expect(status({ ready: null })).toContain(en.admin.certificates.unknown);
    expect(status({ ready: true })).toContain(en.admin.certificates.ready);
  });

  describe("submit", () => {
    const fetchMock = vi.fn();
    const type = (f: ReturnType<typeof mount>, id: string, value: string) => byId(f.render(), id)!.props.onChange({ target: { value } });
    const choose = (f: ReturnType<typeof mount>, p: DnsProvider) => byId(f.render(), "dns-provider")!.props.onChange({ target: { value: p } });
    const submit = async (f: ReturnType<typeof mount>) => {
      const form = find(f.render(), (n) => n.type === "form")[0]!;
      await form.props.onSubmit({ preventDefault() {} });
    };
    const form = (initial: DnsProviderSettingsDto) => mount(DnsProviderForm, { csrfToken: "c", initial });
    beforeEach(() => {
      fetchMock.mockReset();
      vi.stubGlobal("fetch", fetchMock);
    });

    it("sends no empty field, so a stored value is never erased", async () => {
      fetchMock.mockResolvedValue(json({ data: dto({ provider: "ovh", fieldsSet: ["OVH_ENDPOINT", "OVH_APPLICATION_KEY", "OVH_APPLICATION_SECRET", "OVH_CONSUMER_KEY"] }) }));
      const f = form(dto({ provider: "ovh", fieldsSet: ["OVH_ENDPOINT", "OVH_APPLICATION_KEY", "OVH_APPLICATION_SECRET", "OVH_CONSUMER_KEY"] }));
      type(f, "dns-OVH_APPLICATION_KEY", "new-key");
      type(f, "dns-OVH_CONSUMER_KEY", "x");
      type(f, "dns-OVH_CONSUMER_KEY", ""); // typed, then cleared again
      await submit(f);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("/api/admin/dns-provider");
      expect(init.method).toBe("PATCH");
      expect(init.headers["X-CSRF-Token"]).toBe("c");
      expect(JSON.parse(init.body)).toEqual({ provider: "ovh", credentials: { OVH_APPLICATION_KEY: "new-key" } });
    });

    it("saving with everything stored and nothing typed sends an empty credentials object", async () => {
      fetchMock.mockResolvedValue(json({ data: dto() }));
      await submit(form(dto()));
      expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ provider: "cloudflare", credentials: {} });
    });

    it("changing the provider drops the old marks and demands the required values again", async () => {
      const f = form(dto());
      choose(f, "hetzner");
      expect(find(f.render(), (n) => n.props.children === en.admin.certificates.fieldSet)).toHaveLength(0);
      await submit(f);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(text(byId(f.render(), "dns-HETZNER_API_TOKEN-err"))).toBe(en.admin.certificates.field.field_required);
    });

    it("a local zod message shows its catalog text; the typed value is not echoed anywhere in the messages", async () => {
      const f = form(dto({ provider: "httpreq", fieldsSet: [] }));
      type(f, "dns-HTTPREQ_ENDPOINT", "not-a-url-s3cret");
      await submit(f);
      expect(fetchMock).not.toHaveBeenCalled();
      const tree = f.render();
      expect(text(byId(tree, "dns-HTTPREQ_ENDPOINT-err"))).toBe(en.admin.certificates.field.endpoint_invalid);
      expect(text(tree)).not.toContain("s3cret");
    });

    it("clears the typed secrets after a successful save and never renders the stored value", async () => {
      fetchMock.mockResolvedValue(json({ data: dto({ applied: false, ready: null }) }));
      const f = form(dto({ provider: null, fieldsSet: [], updatedAt: null, ready: null }));
      choose(f, "cloudflare");
      type(f, "dns-CLOUDFLARE_DNS_API_TOKEN", "tok-s3cret");
      await submit(f);
      const tree = f.render();
      expect(byId(tree, "dns-CLOUDFLARE_DNS_API_TOKEN")!.props.value).toBe("");
      expect(JSON.stringify(tree)).not.toContain("s3cret");
      expect(text(find(tree, (n) => n.props.role === "status"))).toContain(en.admin.certificates.saved);
    });

    it("an API refusal never prints text from the response that is not a catalog key", async () => {
      fetchMock.mockResolvedValue(
        json({ error: { code: "VALIDATION_ERROR", details: [{ field: "credentials.CLOUDFLARE_DNS_API_TOKEN", message: "bad value tok-s3cret" }] } }, 422),
      );
      const f = form(dto());
      type(f, "dns-CLOUDFLARE_DNS_API_TOKEN", "tok-s3cret");
      await submit(f);
      const tree = f.render();
      expect(alerts(tree)).toEqual([en.errors.VALIDATION_ERROR]);
      expect(text(tree)).not.toContain("bad value");
    });

    it("an API refusal with a catalog key shows the field text", async () => {
      fetchMock.mockResolvedValue(
        json({ error: { code: "VALIDATION_ERROR", details: [{ field: "credentials.CLOUDFLARE_DNS_API_TOKEN", message: "value_invalid" }] } }, 422),
      );
      const f = form(dto());
      type(f, "dns-CLOUDFLARE_DNS_API_TOKEN", "tok");
      await submit(f);
      const tree = f.render();
      expect(text(byId(tree, "dns-CLOUDFLARE_DNS_API_TOKEN-err"))).toBe(en.admin.certificates.field.value_invalid);
      expect(alerts(tree)).toEqual([en.admin.certificates.field.value_invalid]);
    });

    it("a network failure shows the generic error", async () => {
      fetchMock.mockRejectedValue(new Error("boom tok-s3cret"));
      const f = form(dto());
      type(f, "dns-CLOUDFLARE_DNS_API_TOKEN", "tok-s3cret");
      await submit(f);
      expect(alerts(f.render())).toEqual([en.errors.generic]);
    });

    it("removing explains dns_challenge_in_use and keeps the provider", async () => {
      fetchMock.mockResolvedValue(json({ error: { code: "VALIDATION_ERROR", details: [{ reason: "dns_challenge_in_use" }] } }, 422));
      const f = form(dto());
      await find(f.render(), (n) => n.props.variant === "destructive" && !!n.props.onClick)[0]!.props.onClick();
      expect(fetchMock.mock.calls[0]![1].method).toBe("DELETE");
      const tree = f.render();
      expect(alerts(tree)).toEqual([en.admin.certificates.inUse]);
      expect(find(tree, (n) => n.props.children === en.admin.certificates.remove).length).toBeGreaterThan(0);
    });

    it("a poll that started before a save cannot overwrite the saved state", async () => {
      vi.useFakeTimers();
      let release!: (r: Response) => void;
      fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => (release = r)));
      const f = form(dto({ applied: false, ready: null }));
      f.render();
      const stop = h.effects[0]!() as () => void; // the polling effect
      await vi.advanceTimersByTimeAsync(5000); // the poll's GET is now in flight
      fetchMock.mockResolvedValueOnce(json({ data: dto({ applied: false, ready: null, fieldsSet: ["CLOUDFLARE_DNS_API_TOKEN"] }) }));
      type(f, "dns-CLOUDFLARE_DNS_API_TOKEN", "t");
      await submit(f);
      release(json({ data: dto({ provider: null, fieldsSet: [], updatedAt: null, applied: true, ready: null }) })); // the stale answer
      await vi.advanceTimersByTimeAsync(0);
      stop();
      expect(byId(f.render(), "dns-provider")!.props.value).toBe("cloudflare");
      expect(text(f.render())).not.toContain(en.admin.certificates.notConfigured);
    });
  });
});

// ---------- (3) BFF route ----------

describe("dns-provider BFF", () => {
  beforeEach(() => fetchUpstream.mockReset());

  it("forwards exactly the body the form sends, with the session token", async () => {
    fetchUpstream.mockResolvedValue({ ok: true, status: 200, data: { data: dto() } });
    const body = { provider: "ovh", credentials: { OVH_APPLICATION_KEY: "k" } };
    await PATCH(req("PATCH", {}, body));
    expect(fetchUpstream).toHaveBeenCalledWith("v1/admin/dns-provider", expect.objectContaining({ method: "PATCH", accessToken: "tok", body }));
  });

  it("answers GET without a session with 401 and never calls the API", async () => {
    h.session = null;
    expect((await GET(req("GET"))).status).toBe(401);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("refuses PATCH and DELETE without a session, and with a foreign origin, before the API is called", async () => {
    h.session = null;
    expect((await PATCH(req("PATCH", {}, { provider: "ovh" }))).status).toBe(401);
    expect((await DELETE(req("DELETE"))).status).toBe(401);
    h.session = { accessToken: "tok", csrfToken: "csrf" };
    expect((await PATCH(req("PATCH", { Origin: "http://evil.example" }, { provider: "ovh" }))).status).toBe(403);
    expect((await DELETE(req("DELETE", { "X-CSRF-Token": "" }))).status).toBe(403);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("passes the API refusal of a non-admin session through (status and code)", async () => {
    const error = { error: { code: "PERMISSION_DENIED", message: "denied" } };
    fetchUpstream.mockResolvedValue({ ok: false, status: 403, error });
    for (const res of [await GET(req("GET")), await PATCH(req("PATCH", {}, { provider: "ovh" })), await DELETE(req("DELETE"))]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(error);
    }
  });

  it("passes a validation error through and does not echo the credential values", async () => {
    const error = { error: { code: "VALIDATION_ERROR", details: [{ field: "credentials.OVH_ENDPOINT", message: "ovh_endpoint_invalid" }] } };
    fetchUpstream.mockResolvedValue({ ok: false, status: 422, error });
    const res = await PATCH(req("PATCH", {}, { provider: "ovh", credentials: { OVH_ENDPOINT: "s3cret-endpoint" } }));
    expect(res.status).toBe(422);
    const out = await res.text();
    expect(JSON.parse(out)).toEqual(error);
    expect(out).not.toContain("s3cret");
  });

  it("rejects a malformed or oversized body without echoing it and without calling the API", async () => {
    const bad = await PATCH(req("PATCH", {}, undefined, '{"provider":"ovh","credentials":{"OVH_ENDPOINT":"s3cret'));
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain("s3cret");
    const big = await PATCH(req("PATCH", {}, { provider: "ovh", credentials: { OVH_ENDPOINT: "s3cret".padEnd(1_100_000, "x") } }));
    expect(big.status).toBe(413);
    expect(await big.text()).not.toContain("s3cret");
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("the GET answer keeps provider, fieldsSet and status intact (the key redaction must not eat them)", async () => {
    const d = dto({ provider: "ovh", fieldsSet: ["OVH_APPLICATION_SECRET", "OVH_CONSUMER_KEY"] });
    fetchUpstream.mockResolvedValue({ ok: true, status: 200, data: { data: d } });
    expect(await (await GET(req("GET"))).json()).toEqual({ data: d });
  });
});

describe("domain challenge BFF guard", () => {
  beforeEach(() => fetchUpstream.mockReset());

  it("refuses without a session, rejects an unsafe path segment, and passes the API refusal through", async () => {
    h.session = null;
    expect((await setChallenge(req("PATCH", {}, { challenge: "dns-01" }), dp)).status).toBe(401);
    h.session = { accessToken: "tok", csrfToken: "csrf" };
    const bad = { params: Promise.resolve({ siteId: "s1", domainId: "../x" }) };
    expect((await setChallenge(req("PATCH", {}, { challenge: "dns-01" }), bad)).status).toBe(400);
    expect(fetchUpstream).not.toHaveBeenCalled();

    const error = { error: { code: "VALIDATION_ERROR", details: [{ reason: "dns_provider_missing" }] } };
    fetchUpstream.mockResolvedValue({ ok: false, status: 422, error });
    const res = await setChallenge(req("PATCH", {}, { challenge: "dns-01" }), dp);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(error);
  });
});

// ---------- (4) admin domain control + pages ----------

describe("admin challenge control", () => {
  const panel = (m: typeof en, d: SiteDomainsDto, challenge?: { dnsAvailable: boolean }) =>
    markup(m, createElement(DomainsPanel, { basePath: "/b", csrfToken: "c", initial: d, challenge }));

  it("without a provider the dns-01 option is disabled and noProvider is explained once, in both languages", () => {
    for (const m of [en, itMsgs]) {
      const html = panel(m, domains(dom("hotel.it"), dom("www.hotel.it")), { dnsAvailable: false });
      expect(html.split(`<option value="dns-01" disabled="">`).length - 1).toBe(2);
      expect(html).not.toContain(`<option value="http-01" disabled`);
      expect(html.split(m.admin.sites.challenge.noProvider).length - 1).toBe(1);
    }
  });

  it("a domain that already uses dns-01 keeps its option enabled and selected even when the provider is unavailable", () => {
    const html = panel(en, domains(dom("hotel.it", "dns-01")), { dnsAvailable: false });
    expect(html).toMatch(/<option value="dns-01" selected="">/);
    expect(html).not.toContain(`<option value="dns-01" disabled`);
  });

  it("with a provider no note is shown and each row has its own labelled select", () => {
    const html = panel(en, domains(dom("hotel.it"), dom("www.hotel.it", "dns-01")), { dnsAvailable: true });
    expect(html).not.toContain(en.admin.sites.challenge.noProvider);
    for (const id of ["hotel.it", "www.hotel.it"]) expect(html).toContain(`for="challenge-${id}"`);
    expect(html).toContain('id="challenge-www.hotel.it"');
  });

  describe("change", () => {
    const fetchMock = vi.fn();
    beforeEach(() => {
      fetchMock.mockReset();
      vi.stubGlobal("fetch", fetchMock);
    });
    const change = async (value: string) => {
      const f = mount(DomainsPanel, { basePath: "/api/admin/sites/s1/domains", csrfToken: "c", initial: domains(dom("hotel.it")), challenge: { dnsAvailable: true } });
      await byId(f.render(), "challenge-hotel.it")!.props.onChange({ target: { value } });
      return f.render();
    };

    it("sends PATCH {challenge} to the domain and shows the new value", async () => {
      fetchMock.mockResolvedValue(json({ data: domains(dom("hotel.it", "dns-01")) }));
      const tree = await change("dns-01");
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("/api/admin/sites/s1/domains/hotel.it");
      expect(init.method).toBe("PATCH");
      expect(init.headers["X-CSRF-Token"]).toBe("c");
      expect(JSON.parse(init.body)).toEqual({ challenge: "dns-01" });
      expect(byId(tree, "challenge-hotel.it")!.props.value).toBe("dns-01");
    });

    it("dns_provider_missing from the API (provider removed meanwhile) shows noProvider, not the hostname error", async () => {
      fetchMock.mockResolvedValue(json({ error: { code: "VALIDATION_ERROR", details: [{ reason: "dns_provider_missing" }] } }, 422));
      const tree = await change("dns-01");
      expect(alerts(tree)).toEqual([en.admin.sites.challenge.noProvider]);
      expect(byId(tree, "challenge-hotel.it")!.props.value).toBe("http-01");
    });
  });
});

describe("admin pages", () => {
  beforeEach(() => {
    fetchServerAdminDnsProvider.mockReset();
    fetchServerAdminSiteDomains.mockReset();
  });
  const domainsPage = async (dns: DnsProviderSettingsDto | null) => {
    fetchServerAdminSiteDomains.mockResolvedValue(domains(dom("hotel.it")));
    fetchServerAdminDnsProvider.mockResolvedValue(dns);
    const tree = await AdminSiteDomainsPage({ params: Promise.resolve({ siteId: "s1" }) });
    return find(tree, (n) => n.type === DomainsPanel)[0]!;
  };

  it("the admin domains page disables dns-01 only when no provider is saved", async () => {
    expect((await domainsPage(dto()))!.props.challenge).toEqual({ dnsAvailable: true });
    expect((await domainsPage(dto({ provider: null, fieldsSet: [], updatedAt: null, ready: null })))!.props.challenge).toEqual({ dnsAvailable: false });
    // A failed read is not "no provider": dns-01 stays open and the API refuses it if none is set.
    expect((await domainsPage(null))!.props.challenge).toEqual({ dnsAvailable: true });
    expect((await domainsPage(dto()))!.props.basePath).toBe("/api/admin/sites/s1/domains");
  });

  it("the certificates page renders the form with the saved settings, or an error when they cannot be read", async () => {
    fetchServerAdminDnsProvider.mockResolvedValue(dto());
    const ok = await AdminCertificatesPage();
    expect(find(ok, (n) => n.type === DnsProviderForm)[0]!.props).toMatchObject({ csrfToken: "csrf", initial: dto() });

    fetchServerAdminDnsProvider.mockResolvedValue(null);
    const down = await AdminCertificatesPage();
    expect(find(down, (n) => n.type === DnsProviderForm)).toHaveLength(0);
    expect(text(down)).toContain(en.errors.generic);
  });

  it("both pages send an anonymous visitor to the login", async () => {
    h.session = null;
    await expect(AdminCertificatesPage()).rejects.toThrow("REDIRECT /login");
    await expect(AdminSiteDomainsPage({ params: Promise.resolve({ siteId: "s1" }) })).rejects.toThrow("REDIRECT /login");
    expect(fetchServerAdminDnsProvider).not.toHaveBeenCalled();
  });
});

// ---------- (5) customer panel ----------

describe("customer domains panel", () => {
  it("shows the method of every domain as plain text and offers no challenge control or admin text", () => {
    for (const m of [en, itMsgs]) {
      const html = markup(m, createElement(DomainsPanel, { basePath: "/b", csrfToken: "c", initial: domains(dom("hotel.it"), dom("dns.hotel.it", "dns-01")) }));
      expect(html).not.toContain("<select");
      expect(html).not.toContain("<option");
      expect(html).not.toContain('id="challenge-');
      expect(html).not.toContain(m.admin.sites.challenge.noProvider);
      expect(html).not.toContain(`>${m.admin.sites.challenge.label}</label>`);
      expect(html).toContain(`<p class="text-sm text-muted-foreground">${m.site.domains.challenge["http-01"]}</p>`);
      expect(html).toContain(`<p class="text-sm text-muted-foreground">${m.site.domains.challenge["dns-01"]}</p>`);
    }
  });

  it("the customer tree has no select and no handler that could send a challenge", () => {
    const tree = mount(DomainsPanel, { basePath: "/b", csrfToken: "c", initial: domains(dom("hotel.it", "dns-01")) }).render();
    expect(find(tree, (n) => n.type === "select")).toHaveLength(0);
    expect(find(tree, (n) => String(n.props.id ?? "").startsWith("challenge-"))).toHaveLength(0);
  });
});
