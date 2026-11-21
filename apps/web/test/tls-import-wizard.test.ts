import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SiteDomainDto, TlsCertificateDto, TlsCertificateVersionDto } from "@hosting-panel/contracts";
import {
  activateVersion,
  cancelAction,
  discardCertificate,
  EMPTY_PEM,
  ImportFormStep,
  importFormIssues,
  importStepModel,
  pendingVersion,
  reviewDomains,
  reviewRows,
  ReviewStep,
  submitImport,
} from "@/components/customer/tls-import-dialog";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import type { Messages } from "@/i18n";
import { I18nProvider } from "@/i18n/provider";

const BASE = "/api/bff/orgs/org1/managed-sites/site1";
const ADMIN = "/api/admin/sites/site1";
const NOW = new Date("2026-06-01T12:00:00Z");
const DAY = 86_400_000;

const version = (over: Partial<TlsCertificateVersionDto> = {}): TlsCertificateVersionDto => ({
  id: "ctv_" + "a".repeat(32),
  versionNumber: 1,
  status: "pending",
  subject: "shop.example.com",
  issuer: "Example CA",
  sanDns: ["shop.example.com", "*.cdn.example.com"],
  wildcard: true,
  notBefore: new Date(NOW.getTime() - 10 * DAY).toISOString(),
  notAfter: new Date(NOW.getTime() + 200 * DAY).toISOString(),
  serialNumber: "01",
  fingerprintSha256: "ab".repeat(32),
  keyType: "rsa",
  keyBits: 2048,
  createdAt: NOW.toISOString(),
  activatedAt: null,
  problem: null,
  ...over,
});

const cert = (over: Partial<TlsCertificateDto> = {}): TlsCertificateDto => ({
  id: "cti_" + "b".repeat(32),
  name: "Shop 2026",
  source: "manual",
  createdForSiteId: "site1",
  activeVersionId: null,
  versions: [version()],
  coveredDomains: [
    { domainId: "d1", hostname: "shop.example.com", assigned: false, versionId: null },
    { domainId: "d2", hostname: "www.shop.example.com", assigned: true, versionId: "ctv_old" },
    { domainId: "dX", hostname: "other-site.example.com", assigned: false, versionId: null },
  ],
  assignedDomains: [],
  expiry: null,
  warnings: [],
  updatedAt: NOW.toISOString(),
  ...over,
});

const domain = (id: string, hostname: string): SiteDomainDto =>
  ({ id, hostname }) as unknown as SiteDomainDto;
const SITE_DOMAINS = [domain("d1", "shop.example.com"), domain("d2", "www.shop.example.com"), domain("d3", "blog.example.com")];

const render = (locale: "it" | "en", node: React.ReactElement) =>
  renderToStaticMarkup(
    createElement(I18nProvider, { locale, messages: (locale === "en" ? en : itMsgs) as Messages, children: node }),
  );

const noop = () => undefined;
const formProps = (over: Partial<Parameters<typeof ImportFormStep>[0]> = {}) => ({
  isNew: true,
  pem: EMPTY_PEM,
  issues: {},
  fileErrors: {},
  busy: false,
  error: null,
  onName: noop,
  onPem: noop,
  onFile: noop,
  onSubmit: noop,
  onCancel: noop,
  ...over,
});
const reviewProps = (over: Partial<Parameters<typeof ReviewStep>[0]> = {}) => ({
  rows: reviewRows(version(), en as Messages, "en", NOW),
  domains: reviewDomains(cert(), SITE_DOMAINS, "d1"),
  busy: null,
  error: null,
  onToggle: noop,
  onConfirm: noop,
  onKeep: noop,
  onCancel: noop,
  ...over,
});

describe("PEM hygiene", () => {
  // The hints quote the "-----BEGIN CERTIFICATE-----" marker; a PEM block would carry base64 after it.
  const PEM_BODY = /-----BEGIN [A-Z ]+-----\s*[A-Za-z0-9+/=]{4}/;
  const FORBIDDEN = /localStorage|sessionStorage|indexedDB|console\.|pfx|p12|pkcs12|password/i;

  it("the dialog source uses no web storage, no console and has no PFX or password field", () => {
    const src = readFileSync(new URL("../src/components/customer/tls-import-dialog.tsx", import.meta.url), "utf8");
    expect(src).not.toMatch(FORBIDDEN);
    expect(src).not.toMatch(/type="password"/);
  });

  it.each(["it", "en"] as const)("the form step (%s) renders no PEM, no value attribute, hardened textareas", (locale) => {
    for (const isNew of [true, false]) {
      const html = render(locale, createElement(ImportFormStep, formProps({ isNew })));
      expect(html).not.toMatch(PEM_BODY);
      expect(html).not.toMatch(/\svalue=/);
      expect(html).not.toMatch(FORBIDDEN);
      expect(html).not.toMatch(/<textarea[^>]*>[^<]+<\/textarea>/);
      const areas = html.match(/<textarea[^>]*>/g) ?? [];
      expect(areas).toHaveLength(3);
      for (const a of areas) {
        expect(a).toContain('autoComplete="off"');
        expect(a).toContain('spellCheck="false"');
        expect(a).toMatch(/aria-describedby="tls-(leaf|chain|key)-hint"/);
      }
      expect(html.includes('id="tls-name"')).toBe(isNew);
      expect(html).toContain('type="file"');
    }
  });

  it("the wizard copy mentions no PFX and no password in either language", () => {
    for (const m of [en, itMsgs]) expect(JSON.stringify(m.site.domains.tls.wizard)).not.toMatch(FORBIDDEN);
  });

  it("shown issues set aria-invalid and an error text linked by aria-describedby", () => {
    const html = render(
      "en",
      createElement(ImportFormStep, formProps({ issues: { leafPem: "not_pem", name: "invalid_name" }, error: "Boom" })),
    );
    expect(html).toContain(en.site.domains.tls.pemReason.not_pem.replace("'", "&#x27;"));
    expect(html).toContain(en.site.domains.tls.pemReason.invalid_name);
    expect(html).toMatch(/<textarea[^>]*id="tls-leaf"[^>]*aria-invalid="true"|<textarea[^>]*aria-invalid="true"[^>]*id="tls-leaf"/);
    expect(html).toMatch(/aria-describedby="tls-leaf-hint tls-leaf-err"/);
    expect(html).toContain('id="tls-leaf-err"');
    expect(html).toMatch(/role="alert"[^>]*>.*Boom/);
    expect(html).not.toMatch(/<textarea[^>]*id="tls-key"[^>]*aria-invalid/);
  });

  it("a busy form announces progress politely and disables the fields", () => {
    const html = render("en", createElement(ImportFormStep, formProps({ busy: true })));
    expect(html).toMatch(/role="status"[^>]*aria-live="polite"/);
    expect(html.match(/<textarea[^>]*disabled/g)).toHaveLength(3);
  });

  it("the review step carries no PEM and no value attribute", () => {
    const html = render("it", createElement(ReviewStep, reviewProps({ rows: reviewRows(version(), itMsgs as Messages, "it", NOW) })));
    expect(html).not.toMatch(PEM_BODY);
    expect(html).not.toMatch(/<textarea|\svalue=/);
    expect(html).not.toMatch(FORBIDDEN);
  });
});

describe("importFormIssues", () => {
  it("reports required fields and keeps the chain optional", () => {
    expect(importFormIssues({ ...EMPTY_PEM, name: "" })).toEqual({ name: "required", leafPem: "required", privateKeyPem: "required" });
    expect(importFormIssues({ ...EMPTY_PEM })).toEqual({ leafPem: "required", privateKeyPem: "required" });
  });

  it("names the wrong kind of block and the encrypted key", () => {
    const leaf = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n";
    const encrypted = "-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----\n";
    expect(importFormIssues({ name: "x", leafPem: leaf, chainPem: "", privateKeyPem: encrypted })).toEqual({
      privateKeyPem: "encrypted_key",
    });
    expect(importFormIssues({ name: "x", leafPem: encrypted, chainPem: "", privateKeyPem: encrypted }).leafPem).toBe("wrong_block_type");
  });
});

describe("importStepModel", () => {
  it("a 201 goes to review and zeroes the pasted texts", () => {
    expect(importStepModel({ ok: true })).toEqual({ step: "review", clearPem: true, error: null });
  });

  it("a refusal returns to the form with the mapped error and clears the texts", () => {
    expect(importStepModel({ ok: false, code: "CERTIFICATE_INVALID", reason: "key_mismatch", keyKept: false })).toEqual({
      step: "form",
      clearPem: true,
      error: { code: "CERTIFICATE_INVALID", reason: "key_mismatch" },
    });
  });

  it("a 5xx or lost reply keeps the texts so a retry replays under the same key", () => {
    const m = importStepModel({ ok: false, code: "", keyKept: true });
    expect(m).toMatchObject({ step: "form", clearPem: false });
  });
});

const PEM = {
  leafPem: "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n",
  chainPem: "",
  privateKeyPem: "-----BEGIN PRIVATE KEY-----\nBBBB\n-----END PRIVATE KEY-----\n",
};

function mockFetch(...replies: Array<{ status: number; body?: unknown } | Error>) {
  const f = vi.fn(async () => {
    const r = replies.shift()!;
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", f);
  return f;
}
const call = (f: ReturnType<typeof vi.fn>, n: number) => {
  const [url, init] = f.mock.calls[n] as unknown as [string, RequestInit];
  const headers = init.headers as Record<string, string>;
  return { url, method: init.method, key: headers["Idempotency-Key"], csrf: headers["X-CSRF-Token"], body: init.body ? JSON.parse(init.body as string) : undefined };
};

afterEach(() => vi.unstubAllGlobals());

describe("submitImport", () => {
  it("posts a new certificate with its name, the PEM format and a CSRF token", async () => {
    const f = mockFetch({ status: 201, body: { data: cert() } });
    const keys: Record<string, string> = {};
    const out = await submitImport(keys, "csrf", BASE, undefined, "  Shop 2026 ", PEM);
    expect(call(f, 0)).toMatchObject({
      url: `${BASE}/tls-certificates`,
      method: "POST",
      csrf: "csrf",
      body: { name: "Shop 2026", format: "pem", ...PEM },
    });
    expect(call(f, 0).key).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.model).toEqual({ step: "review", clearPem: true, error: null });
    expect(out.certificate?.id).toBe(cert().id);
    expect(keys).toEqual({});
  });

  it("a new version goes to the certificate's versions route without a name (admin base too)", async () => {
    const f = mockFetch({ status: 201, body: { data: cert() } });
    await submitImport({}, "csrf", ADMIN, "cti_x", "ignored", PEM);
    const c = call(f, 0);
    expect(c.url).toBe(`${ADMIN}/tls-certificates/cti_x/versions`);
    expect(c.body).toEqual({ format: "pem", ...PEM });
  });

  it("a 5xx and a lost reply keep the key and the texts; the retry replays under the same key", async () => {
    const f = mockFetch({ status: 502, body: { error: { code: "INTERNAL_ERROR", details: [] } } }, new Error("net"), {
      status: 201,
      body: { data: cert() },
    });
    const keys: Record<string, string> = {};
    const first = await submitImport(keys, "csrf", BASE, undefined, "n", PEM);
    expect(first.model).toMatchObject({ step: "form", clearPem: false, error: { code: "INTERNAL_ERROR" } });
    const second = await submitImport(keys, "csrf", BASE, undefined, "n", PEM);
    expect(second.model).toMatchObject({ clearPem: false });
    const third = await submitImport(keys, "csrf", BASE, undefined, "n", PEM);
    expect(third.model.step).toBe("review");
    expect(new Set([0, 1, 2].map((i) => call(f, i).key)).size).toBe(1);
    expect(keys).toEqual({});
  });

  it("a 4xx renews the key, clears the texts and carries the first reason", async () => {
    const f = mockFetch(
      { status: 422, body: { error: { code: "CERTIFICATE_INVALID", details: [{ field: "privateKeyPem", reason: "key_mismatch" }] } } },
      { status: 201, body: { data: cert() } },
    );
    const keys: Record<string, string> = {};
    const first = await submitImport(keys, "csrf", BASE, undefined, "n", PEM);
    expect(first.model).toEqual({ step: "form", clearPem: true, error: { code: "CERTIFICATE_INVALID", reason: "key_mismatch" } });
    expect(keys).toEqual({});
    await submitImport(keys, "csrf", BASE, undefined, "n", PEM);
    expect(call(f, 0).key).not.toBe(call(f, 1).key);
  });

  it("a 201 that is not a pending certificate is refused, never reviewed", async () => {
    mockFetch({ status: 201, body: { data: cert({ versions: [version({ status: "active" })] }) } });
    const out = await submitImport({}, "csrf", BASE, undefined, "n", PEM);
    expect(out.certificate).toBeNull();
    expect(out.model.step).toBe("form");
  });
});

describe("activateVersion and cancel", () => {
  const domainsDto = { serverIpv4: "1.2.3.4", routesPending: true, domains: [], mail: { configured: false, fromAddress: null } };

  it("confirm posts the chosen domain ids to the activate route and parses the 202 list", async () => {
    const f = mockFetch({ status: 202, body: { data: domainsDto } });
    const res = await activateVersion({}, "csrf", BASE, "cti_x", "ctv_y", ["d1", "d2"]);
    expect(call(f, 0)).toMatchObject({
      url: `${BASE}/tls-certificates/cti_x/versions/ctv_y/activate`,
      method: "POST",
      body: { domainIds: ["d1", "d2"] },
    });
    expect(res).toEqual({ ok: true, domains: domainsDto });
  });

  it("confirm keeps its key after a 503 and renews it after a 409", async () => {
    const f = mockFetch(
      { status: 503, body: { error: { code: "UNAVAILABLE" } } },
      { status: 409, body: { error: { code: "RESOURCE_LOCKED" } } },
      { status: 202, body: { data: domainsDto } },
    );
    const keys: Record<string, string> = {};
    await activateVersion(keys, "c", BASE, "cti_x", "ctv_y", ["d1"]);
    await activateVersion(keys, "c", BASE, "cti_x", "ctv_y", ["d1"]);
    await activateVersion(keys, "c", BASE, "cti_x", "ctv_y", ["d1"]);
    expect(call(f, 0).key).toBe(call(f, 1).key);
    expect(call(f, 2).key).not.toBe(call(f, 1).key);
  });

  it("cancelling a brand-new certificate issues a DELETE; a replacement issues nothing", async () => {
    expect(cancelAction(false)).toBe("delete");
    expect(cancelAction(true)).toBe("close");
    const f = mockFetch({ status: 204 });
    const res = await discardCertificate({}, "csrf", ADMIN, "cti_x");
    expect(res.ok).toBe(true);
    expect(call(f, 0)).toMatchObject({ url: `${ADMIN}/tls-certificates/cti_x`, method: "DELETE", csrf: "csrf" });
  });
});

describe("review", () => {
  it("rows show subject, issuer, names, wildcard, validity with its tier, fingerprint and key", () => {
    const rows = reviewRows(version(), en as Messages, "en", NOW);
    const by = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    expect(by.subject).toBe("shop.example.com");
    expect(by.issuer).toBe("Example CA");
    expect(by.names).toBe("shop.example.com, *.cdn.example.com");
    expect(by.wildcard).toContain("cdn.example.com");
    expect(by.validity).toMatch(/Valid from .* to .*Valid until/);
    expect(by.fingerprint).toBe(Array(32).fill("AB").join(":"));
    expect(by.key).toBe("RSA key, 2048 bit");
  });

  it("an expiring certificate shows its tier text; no wildcard and an EC key are worded plainly", () => {
    const soon = version({ notAfter: new Date(NOW.getTime() + 5 * DAY).toISOString(), sanDns: ["a.example.com"], keyType: "ec", keyBits: 256 });
    const by = Object.fromEntries(reviewRows(soon, itMsgs as Messages, "it", NOW).map((r) => [r.key, r.value]));
    expect(by.validity).toContain("Scade tra 5 giorni");
    expect(by.wildcard).toBe(itMsgs.site.domains.tls.wizard.reviewNoWildcard);
    expect(by.key).toBe(itMsgs.site.domains.tls.wizard.reviewKeyEc);
  });

  it("lists only this site's covered domains; checked = already on the certificate or the one opened from", () => {
    expect(reviewDomains(cert(), SITE_DOMAINS, "d1")).toEqual([
      { id: "d1", hostname: "shop.example.com", checked: true },
      { id: "d2", hostname: "www.shop.example.com", checked: true },
    ]);
    expect(reviewDomains(cert(), SITE_DOMAINS)).toEqual([
      { id: "d1", hostname: "shop.example.com", checked: false },
      { id: "d2", hostname: "www.shop.example.com", checked: true },
    ]);
    expect(reviewDomains(cert({ coveredDomains: [] }), SITE_DOMAINS)).toEqual([]);
  });

  it("pendingVersion picks the newest pending version", () => {
    const c = cert({ versions: [version({ id: "v1" }), version({ id: "v2", versionNumber: 2 }), version({ id: "v3", versionNumber: 3, status: "active" })] });
    expect(pendingVersion(c)?.id).toBe("v2");
    expect(pendingVersion(cert({ versions: [version({ status: "active" })] }))).toBeNull();
  });

  it.each(["it", "en"] as const)("the review step (%s) never claims the certificate is active", (locale) => {
    const messages = locale === "en" ? en : itMsgs;
    const w = messages.site.domains.tls.wizard as Record<string, string>;
    const copy = Object.entries(w)
      .filter(([k]) => k.startsWith("review") || k === "warningNoActiveYet" || k === "confirm" || k === "keepForLater")
      .map(([, v]) => v)
      .join(" ");
    expect(copy).not.toMatch(/\b(attivo|attiva|active)\b/i);
    const html = render(locale, createElement(ReviewStep, reviewProps({ rows: reviewRows(version(), messages as Messages, locale, NOW) })));
    expect(html).not.toMatch(/\b(attivo|attiva|active)\b/i);
    expect(html).toContain(w.warningNoActiveYet);
    expect(html).toContain(w.reviewIntro);
  });

  it("renders one checkbox per covered domain with the defaults, and Confirm needs a checked domain", () => {
    const html = render("en", createElement(ReviewStep, reviewProps()));
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html.match(/checked=""/g)).toHaveLength(2);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Use this certificate/);
    const none = render("en", createElement(ReviewStep, reviewProps({ domains: [] })));
    expect(none).toContain(en.site.domains.tls.wizard.reviewNoDomains);
    expect(none).toMatch(/<button[^>]*disabled=""[^>]*>Use this certificate/);
    expect(none).toContain(en.site.domains.tls.wizard.keepForLater);
  });

  it("errors are announced with role=alert and progress with role=status", () => {
    const html = render("en", createElement(ReviewStep, reviewProps({ error: "Nope", busy: "confirm" })));
    expect(html).toMatch(/role="alert"/);
    expect(html).toMatch(/role="status"[^>]*aria-live="polite"/);
  });

  it("the status line says Cancelling… (not the button label) while a new certificate is being cancelled", () => {
    for (const [locale, messages] of [["en", en], ["it", itMsgs]] as const) {
      const w = messages.site.domains.tls.wizard;
      const html = render(locale, createElement(ReviewStep, reviewProps({ busy: "cancel" })));
      expect(html).toMatch(new RegExp(`role="status"[^>]*>${w.cancelling}</p>`));
    }
  });
});
