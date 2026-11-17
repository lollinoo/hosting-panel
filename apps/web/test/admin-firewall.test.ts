// M5d (web-fw): the Firewall page, its pure functions and its four BFF routes.
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FIREWALL_BLOCK_REFUSALS,
  FIREWALL_MAX_BLOCKS_PER_FAMILY,
  FIREWALL_MIN_PREFIX,
  FIREWALL_NOTE_MAX,
  FIREWALL_PORT_NAMES,
  FIREWALL_SAFE_PORTS,
  FIREWALL_STATIC_RULES,
  FirewallDtoSchema,
  type FirewallDto,
} from "@hosting-panel/contracts";
import type { Messages } from "@/i18n";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";

const fetchUpstream = vi.fn();
const getSessionFromRequest = vi.fn();
const getServerSession = vi.fn();
const fetchServerAdminFirewall = vi.fn();
const router = { push: vi.fn(), refresh: vi.fn() };
const lang = vi.hoisted(() => ({ locale: "en" as "en" | "it" }));

vi.mock("@/lib/upstream", async () => ({
  ...(await vi.importActual<object>("@/lib/upstream")),
  fetchUpstream: (...a: unknown[]) => fetchUpstream(...a),
}));
vi.mock("@/lib/server-session", () => ({
  getSessionFromRequest: (...a: unknown[]) => getSessionFromRequest(...a),
  getServerSession: (...a: unknown[]) => getServerSession(...a),
}));
vi.mock("@/lib/server-api", () => ({ fetchServerAdminFirewall: (...a: unknown[]) => fetchServerAdminFirewall(...a) }));
vi.mock("@/i18n/server", () => ({ getRequestLocale: async () => lang.locale }));
// Records the props each ConfirmAction gets, then renders the real one (R203 3.5).
const confirmProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("@/components/admin/confirm-action", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/admin/confirm-action")>();
  return { ...real, ConfirmAction: (p: Parameters<typeof real.ConfirmAction>[0]) => (confirmProps.push(p), createElement(real.ConfirmAction, p)) };
});
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  useRouter: () => router,
  usePathname: () => "/admin/firewall",
}));

import AdminFirewallPage from "@/app/admin/firewall/page";
import * as openMod from "@/app/api/admin/firewall/ports/[name]/open/route";
import * as closeMod from "@/app/api/admin/firewall/ports/[name]/close/route";
import * as blocksMod from "@/app/api/admin/firewall/blocks/route";
import * as unblockMod from "@/app/api/admin/firewall/blocks/[blockId]/route";
import { canChangeFirewall, FIREWALL_BFF_TIMEOUT_MS, firewallErrorText, hasNotInForce, needsBaseRules } from "@/lib/admin-firewall";

const SENTINEL = "SENTINEL-fw-5d";
const LANGS: Array<[string, Messages]> = [["en", en], ["it", itMsgs]];

describe("1. firewallErrorText", () => {
  const cases: Array<[string, string | undefined, (m: Messages) => string]> = [
    ...FIREWALL_BLOCK_REFUSALS.map((r) => ["VALIDATION_ERROR", r, (m: Messages) => m.admin.firewall.refusals[r]] as [string, string, (m: Messages) => string]),
    ["VALIDATION_ERROR", "note_invalid", (m) => m.admin.firewall.refusals.note_invalid],
    ["VALIDATION_ERROR", "unknown_port", (m) => m.admin.firewall.refusals.unknown_port],
    ["FIREWALL_BASE_RULES_NOT_CURRENT", undefined, (m) => m.admin.firewall.errors.notCurrent],
    ["NOT_FOUND", undefined, (m) => m.admin.firewall.errors.notFound],
    ["RESOURCE_LOCKED", undefined, (m) => m.admin.firewall.errors.locked],
    ["NOT_SUPPORTED", undefined, (m) => m.admin.firewall.base.disabled],
    ["HOST_AGENT_UNAVAILABLE", undefined, (m) => m.admin.firewall.errors.agentDown],
    ["UNAUTHENTICATED", undefined, (m) => m.admin.firewall.errors.session],
    ["INTERNAL_ERROR", undefined, (m) => m.admin.firewall.errors.noAnswer],
  ];

  it.each(LANGS)("%s: the apply button's answers: a host row gone, no answer, a lost connection", (_l, m) => {
    const e = m.admin.firewall.errors;
    expect(firewallErrorText(m, "NOT_FOUND", undefined, true)).toBe(e.hostGone);
    expect(firewallErrorText(m, "NOT_FOUND")).toBe(e.notFound);
    for (const code of ["OPERATION_AMBIGUOUS", ""]) expect(firewallErrorText(m, code)).toBe(e.noAnswer);
  });

  it.each(LANGS)("%s: every code and reason has its own sentence, filled, with no placeholder left", (_l, m) => {
    const texts = cases.map(([code, reason]) => firewallErrorText(m, code, reason));
    expect(new Set(texts).size).toBe(texts.length);
    for (const [i, [code, reason, key]] of cases.entries()) {
      expect(key(m), `${code}/${reason}`).toBeTruthy();
      expect(texts[i]!.startsWith(key(m).split("{")[0]!), `${code}/${reason}`).toBe(true);
      expect(texts[i], `${code}/${reason}`).not.toContain("{");
    }
    expect(firewallErrorText(m, "VALIDATION_ERROR", "too_wide")).toContain(`/${FIREWALL_MIN_PREFIX.ipv4}`);
    expect(firewallErrorText(m, "VALIDATION_ERROR", "too_wide")).toContain(`/${FIREWALL_MIN_PREFIX.ipv6}`);
    expect(firewallErrorText(m, "VALIDATION_ERROR", "limit")).toContain(String(FIREWALL_MAX_BLOCKS_PER_FAMILY));
    expect(firewallErrorText(m, "VALIDATION_ERROR", "note_invalid")).toContain(String(FIREWALL_NOTE_MAX));
  });

  it.each(LANGS)("%s: an unknown code or reason falls to a general sentence and never echoes it", (_l, m) => {
    for (const [code, reason] of [[SENTINEL, undefined], ["", undefined], ["VALIDATION_ERROR", SENTINEL], ["VALIDATION_ERROR", "__proto__"], [SENTINEL, "invalid"]] as const) {
      const t = firewallErrorText(m, code, reason);
      expect(t).not.toContain(SENTINEL);
      expect(t).not.toContain("{");
      expect(t.length).toBeGreaterThan(0);
    }
    expect(firewallErrorText(m, SENTINEL)).toBe(m.errors.generic);
  });
});

describe("2. the page's states", () => {
  it("only current and unreadable allow changes; absent and outdated need the base rules", () => {
    expect(["current", "outdated", "absent", "unreadable", "disabled"].map((b) => [canChangeFirewall(b as FirewallDto["baseRules"]), needsBaseRules(b as FirewallDto["baseRules"])]))
      .toEqual([[true, false], [false, true], [false, true], [true, false], [false, false]]);
  });

  it("hasNotInForce is true only when a port or a block is stored and not applied", () => {
    const dto = (portInForce: boolean | null, blockInForce: boolean | null) => ({
      ports: [{ name: "nrpe", port: 5666, open: true, inForce: portInForce }],
      blocks: [{ id: `fwb_${"0".repeat(32)}`, address: "192.0.2.10", family: "ipv4", note: null, createdAt: "2026-11-17T06:00:00.000Z", inForce: blockInForce }],
    }) as unknown as FirewallDto;
    expect(hasNotInForce(dto(true, true))).toBe(false);
    expect(hasNotInForce(dto(null, null))).toBe(false);
    expect(hasNotInForce(dto(false, true))).toBe(true);
    expect(hasNotInForce(dto(true, false))).toBe(true);
  });
});

const BLOCK_ID = `fwb_${"0123456789abcdef".repeat(2)}`;

beforeEach(() => {
  fetchUpstream.mockReset().mockResolvedValue({ ok: true, status: 200, data: { data: {} } });
  getSessionFromRequest.mockReset().mockResolvedValue({ accessToken: "tok-sentinel", csrfToken: "csrf" });
  getServerSession.mockReset().mockResolvedValue({ accessToken: "tok-sentinel", csrfToken: "csrf" });
  fetchServerAdminFirewall.mockReset();
  router.refresh.mockReset();
  lang.locale = "en";
});

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call(handler: unknown, method: "POST" | "DELETE", params: Record<string, string>, headers: Record<string, string> = {}, body: unknown = {}) {
  const req = new Request("http://localhost:3000/api/x", {
    method,
    headers: { Host: "localhost:3000", Origin: "http://localhost:3000", "X-CSRF-Token": "csrf", "Content-Type": "application/json", "Idempotency-Key": "key-1", ...headers },
    body: JSON.stringify(body),
  });
  return (handler as Handler)(req, { params: Promise.resolve(params) });
}

describe("3. the four BFF routes", () => {
  it.each([
    ["open", openMod.POST, "POST", { name: "nrpe" }, "v1/admin/firewall/ports/nrpe/open"],
    ["close", closeMod.POST, "POST", { name: "node_exporter" }, "v1/admin/firewall/ports/node_exporter/close"],
    ["block", blocksMod.POST, "POST", {}, "v1/admin/firewall/blocks"],
    ["unblock", unblockMod.DELETE, "DELETE", { blockId: BLOCK_ID }, `v1/admin/firewall/blocks/${BLOCK_ID}`],
  ] as const)("%s forwards to its own upstream path, keyed, with the method it was called with", async (_n, h, method, params, upstream) => {
    const res = await call(h, method, params);
    expect(res.status).toBe(200);
    expect(fetchUpstream).toHaveBeenCalledTimes(1);
    const [path, opts] = fetchUpstream.mock.calls[0]!;
    expect(path).toBe(upstream);
    expect(opts).toMatchObject({ method, accessToken: "tok-sentinel", idempotencyKey: "key-1" });
  });

  it.each([["open", openMod.POST], ["close", closeMod.POST]] as const)("%s: a port name outside the list forwards nothing", async (_n, h) => {
    for (const name of ["ssh", "http", "https", "panel", "NRPE", "nrpe ", "../nrpe", "%2e%2e", "__proto__", "constructor", "22", ""]) {
      expect((await call(h, "POST", { name })).status, name).toBe(400);
    }
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("the unblock route refuses a path segment of a wrong shape", async () => {
    for (const blockId of ["../x", "%2e%2e", "a/b", "", `fwb_${"A".repeat(32)}`, `fwb_${"0".repeat(31)}`]) expect((await call(unblockMod.DELETE, "DELETE", { blockId })).status, blockId).toBe(400);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("the block route passes on x-real-ip only when it is one whole address", async () => {
    const sent = async (headers: Record<string, string>) => {
      fetchUpstream.mockClear();
      await call(blocksMod.POST, "POST", {}, headers, { address: "203.0.113.0/24", note: null });
      return (fetchUpstream.mock.calls[0]![1] as { headers?: Record<string, string> }).headers;
    };
    expect(await sent({ "X-Real-Ip": "192.0.2.10" })).toEqual({ "X-HP-Client-Address": "192.0.2.10" });
    expect(await sent({ "X-Real-Ip": "2001:db8::1" })).toEqual({ "X-HP-Client-Address": "2001:db8::1" });
    for (const v of ["1.2.3.4, 5.6.7.8", "x", " 192.0.2.10x", "192.0.2.0/24"]) expect(await sent({ "X-Real-Ip": v }), v).toBeUndefined();
    expect(await sent({})).toBeUndefined();
    // The browser's own header never reaches the upstream: the upstream headers are built from nothing.
    expect(await sent({ "X-HP-Client-Address": "198.51.100.7" })).toBeUndefined();
    expect(await sent({ "X-HP-Client-Address": "198.51.100.7", "X-Real-Ip": "192.0.2.10" })).toEqual({ "X-HP-Client-Address": "192.0.2.10" });
    expect(fetchUpstream.mock.calls[0]![1]).toMatchObject({ body: { address: "203.0.113.0/24", note: null } });
  });

  it("refusals and statuses of the upstream pass through", async () => {
    const error = { error: { code: "VALIDATION_ERROR", message: "m", requestId: "r", retryable: false, details: [{ reason: "too_wide" }] } };
    fetchUpstream.mockResolvedValue({ ok: false, status: 400, error });
    const res = await call(blocksMod.POST, "POST", {}, {}, { address: "10.0.0.0/8" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "VALIDATION_ERROR", details: [{ reason: "too_wide" }] } });
  });

  // R202 3: one change makes up to three host-agent calls of 20 s each (read, send, read again).
  it.each([
    ["open", openMod.POST, "POST", { name: "nrpe" }],
    ["close", closeMod.POST, "POST", { name: "nrpe" }],
    ["block", blocksMod.POST, "POST", {}],
    ["unblock", unblockMod.DELETE, "DELETE", { blockId: BLOCK_ID }],
  ] as const)("%s hands on a time-out above the API's worst case", async (_n, h, method, params) => {
    await call(h, method, params);
    expect(FIREWALL_BFF_TIMEOUT_MS).toBeGreaterThan(3 * 20_000);
    expect(fetchUpstream.mock.calls[0]![1]).toMatchObject({ timeoutMs: FIREWALL_BFF_TIMEOUT_MS });
  });

  it("the page's own read waits as long", async () => {
    const real = await vi.importActual<typeof import("@/lib/server-api")>("@/lib/server-api");
    getServerSession.mockResolvedValue({ accessToken: "tok-sentinel" });
    fetchUpstream.mockResolvedValue({ ok: true, status: 200, data: { data: {} } });
    await real.fetchServerAdminFirewall();
    expect(fetchUpstream).toHaveBeenCalledWith("v1/admin/firewall", expect.objectContaining({ timeoutMs: FIREWALL_BFF_TIMEOUT_MS }));
  });

  it("without CSRF or Idempotency-Key nothing is forwarded", async () => {
    expect((await call(openMod.POST, "POST", { name: "nrpe" }, { "X-CSRF-Token": "bad" })).status).toBe(403);
    const req = new Request("http://localhost:3000/api/x", { method: "DELETE", headers: { Host: "localhost:3000", Origin: "http://localhost:3000", "X-CSRF-Token": "csrf", "Content-Type": "application/json" }, body: "{}" });
    expect((await unblockMod.DELETE(req, { params: Promise.resolve({ blockId: BLOCK_ID }) })).status).toBe(400);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });
});

const AT = "2026-11-17T06:00:00.000Z";
const dto = (over: Partial<FirewallDto> = {}): FirewallDto => FirewallDtoSchema.parse({
  baseRules: "current",
  readAt: AT,
  hostId: "host_a1",
  staticRules: FIREWALL_STATIC_RULES.map((r) => ({ key: r.key, ports: [...r.ports] })),
  ports: FIREWALL_PORT_NAMES.map((name) => ({ name, port: FIREWALL_SAFE_PORTS[name], open: name === "nrpe", inForce: true })),
  blocks: [
    { id: BLOCK_ID, address: "203.0.113.0/24", family: "ipv4", note: `<b>${SENTINEL}</b>`, createdAt: AT, inForce: true },
    { id: `fwb_${"f".repeat(32)}`, address: "2001:db8::/32", family: "ipv6", note: null, createdAt: "2026-11-16T06:00:00.000Z", inForce: null },
  ],
  ...over,
});
async function page(d: FirewallDto | null, m: Messages = en) {
  lang.locale = m === en ? "en" : "it";
  fetchServerAdminFirewall.mockResolvedValue(d);
  const el = (await AdminFirewallPage()) as ReactNode;
  return renderToStaticMarkup(createElement(I18nProvider, { locale: lang.locale, messages: m, children: el }));
}
const text = (h: string) => h.replace(/<[^>]*>/g, " ").replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
const tags = (h: string, re: RegExp) => [...h.matchAll(new RegExp(`<[^>]*${re.source}[^>]*>`, "g"))].map((x) => x[0]);
const switches = (h: string) => tags(h, /role="switch"/);
const buttonsNamed = (h: string, label: string) => [...h.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].filter((x) => text(x[1]!).trim() === label).map((x) => x[0]);

describe("4. the page", () => {
  const t = en.admin.firewall;

  it("a failed read shows the loadFailed alert and nothing else", async () => {
    const h = await page(null);
    expect(h).toContain(t.loadFailed);
    expect(h).toContain('role="alert"');
    for (const s of [t.static.title, t.portsCard.title, t.blocks.title, t.base.current]) expect(h).not.toContain(s);
  });

  it("disabled shows its one sentence and nothing else", async () => {
    const h = await page(dto({ baseRules: "disabled" }));
    expect(h).toContain(t.base.disabled);
    for (const s of [t.static.title, t.portsCard.title, t.blocks.title, t.base.apply, t.notInForce.banner]) expect(h).not.toContain(s);
    expect(switches(h)).toHaveLength(0);
  });

  it.each(["absent", "outdated"] as const)("%s: the warning, Apply base rules with a hostId, every change control disabled", async (b) => {
    confirmProps.length = 0;
    const h = await page(dto({ baseRules: b }));
    expect(text(h)).toContain(t.base[b]);
    expect(buttonsNamed(h, t.base.apply)).toHaveLength(1);
    // R203 3.5: the apply answers with the base rules' sentences, not those of a block.
    expect(confirmProps.filter((p) => p.label === t.base.apply).map((p) => p.errors)).toEqual(["firewall-base"]);
    expect(buttonsNamed(h, t.base.apply)[0]).not.toMatch(/disabled=""/);
    expect(switches(h)).toHaveLength(FIREWALL_PORT_NAMES.length);
    for (const sw of switches(h)) expect(sw).toMatch(/disabled=""/);
    for (const b2 of [...buttonsNamed(h, t.blocks.add), ...buttonsNamed(h, t.blocks.unblock)]) expect(b2).toMatch(/disabled=""/);
    expect(buttonsNamed(h, t.blocks.unblock)).toHaveLength(2);
    expect(tags(h, /name="address"/)[0]).toMatch(/disabled=""/);
    const noHost = await page(dto({ baseRules: b, hostId: null }));
    // R201 1.8: without a host row there is nothing to apply the rules to; its own sentence, no ask to apply.
    expect(text(noHost)).toContain(t.base.unregistered);
    expect(text(noHost)).not.toContain(t.base[b]);
    expect(buttonsNamed(noHost, t.base.apply)).toHaveLength(0);
  });

  it.each(LANGS)("%s: unmanaged shows its sentence, no apply and no enabled change control", async (_l, m) => {
    const u = m.admin.firewall;
    const h = await page(dto({ baseRules: "unmanaged", ports: dto().ports.map((p) => ({ ...p, inForce: null })), blocks: dto().blocks.map((b) => ({ ...b, inForce: null })) }), m);
    expect(text(h)).toContain(u.base.unmanaged);
    expect(text(h)).not.toContain(u.base.absent);
    expect(buttonsNamed(h, u.base.apply)).toHaveLength(0);
    expect(buttonsNamed(h, u.notInForce.again)).toHaveLength(0);
    expect(switches(h)).toHaveLength(FIREWALL_PORT_NAMES.length);
    for (const sw of switches(h)) expect(sw).toMatch(/disabled=""/);
    const controls = [...buttonsNamed(h, u.blocks.add), ...buttonsNamed(h, u.blocks.unblock)];
    expect(controls).toHaveLength(3);
    for (const b of controls) expect(b).toMatch(/disabled=""/);
    expect(tags(h, /name="address"/)[0]).toMatch(/disabled=""/);
  });

  it("unreadable shows the stored lists with changes allowed", async () => {
    const h = await page(dto({ baseRules: "unreadable", ports: dto().ports.map((p) => ({ ...p, inForce: null })), blocks: dto().blocks.map((b) => ({ ...b, inForce: null })) }));
    expect(text(h)).toContain(t.base.unreadable);
    expect(buttonsNamed(h, t.base.apply)).toHaveLength(0);
    for (const sw of switches(h)) expect(sw).not.toMatch(/disabled=""/);
    for (const b of [...buttonsNamed(h, t.blocks.add), ...buttonsNamed(h, t.blocks.unblock)]) expect(b).not.toMatch(/disabled=""/);
    expect(text(h)).toContain("203.0.113.0/24");
    expect(text(h)).toContain(t.state.unknown);
    expect(h).not.toContain(t.notInForce.banner);
  });

  it("current shows one quiet line, no warning, every control enabled", async () => {
    const h = await page(dto());
    expect(text(h)).toContain(t.base.current);
    for (const s of [t.base.absent, t.base.outdated, t.base.unreadable, t.notInForce.banner]) expect(text(h)).not.toContain(s);
    expect(buttonsNamed(h, t.base.apply)).toHaveLength(0);
    for (const sw of switches(h)) expect(sw).not.toMatch(/disabled=""/);
  });

  it("the sections come in the report's order and the always-open rules say their ports", async () => {
    const h = text(await page(dto()));
    const at = [t.base.current, t.static.title, t.portsCard.title, t.blocks.title].map((s) => h.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(h).toContain("SSH (port 22)");
    expect(h).toContain("Web (ports 80, 443)");
    expect(h).toContain(t.static.why);
  });

  it("one switch per port, in the list's order, its label naming the port and its state in words", async () => {
    const h = await page(dto());
    const sw = switches(h);
    expect(sw.map((s) => /aria-label="([^"]*)"/.exec(s)![1])).toEqual(FIREWALL_PORT_NAMES.map((n) => `Port ${FIREWALL_SAFE_PORTS[n]} open`));
    expect(sw.map((s) => /aria-checked="(\w+)"/.exec(s)![1])).toEqual(FIREWALL_PORT_NAMES.map((n) => String(n === "nrpe")));
    const at = FIREWALL_PORT_NAMES.map((n) => text(h).indexOf(t.ports[n].replace("{port}", String(FIREWALL_SAFE_PORTS[n]))));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(text(h)).toContain(t.portsCard.open);
    expect(text(h)).toContain(t.portsCard.closed);
  });

  it("not in force: the badge on the entry and the banner with Apply again", async () => {
    const d = dto();
    const h = await page({ ...d, ports: d.ports.map((p) => (p.name === "nrpe" ? { ...p, inForce: false } : p)) });
    expect(text(h)).toContain(t.notInForce.banner);
    expect(buttonsNamed(h, t.notInForce.again)).toHaveLength(1);
    expect(text(h)).toContain(t.state.notInForce);
    const b = await page({ ...d, blocks: d.blocks.map((x) => ({ ...x, inForce: false })) });
    expect(text(b)).toContain(t.notInForce.banner);
    expect(text(b).split(t.state.notInForce).length - 1).toBe(2);
    expect(text(await page(d))).not.toContain(t.state.notInForce);
  });

  it("blocks: the form, newest first as sent, the note shown as text, the empty line", async () => {
    const h = await page(dto());
    expect(tags(h, /name="note"/)[0]).toContain(`maxLength="${FIREWALL_NOTE_MAX}"`);
    expect(text(h).indexOf("203.0.113.0/24")).toBeLessThan(text(h).indexOf("2001:db8::/32"));
    expect(h).not.toContain(`<b>${SENTINEL}`);
    expect(h).toContain(`&lt;b&gt;${SENTINEL}&lt;/b&gt;`);
    expect(tags(h, /aria-label="Unblock 203\.0\.113\.0\/24"/)).toHaveLength(1);
    expect(text(await page(dto({ blocks: [] })))).toContain(t.blocks.empty);
  });

  it.each(LANGS)("%s: no kernel word in any sentence the administrator reads or acts on", async (_l, m) => {
    const KERNEL = /nftables|\bchains?\b|\bsets?\b|\btables?\b/i;
    const all: string[] = [];
    const walk = (o: unknown) => (typeof o === "string" ? all.push(o) : Object.values(o as object).forEach(walk));
    walk(m.admin.firewall);
    for (const s of all) expect(s).not.toMatch(KERNEL);
    for (const b of ["current", "absent", "unreadable"] as const) {
      const d = dto({ baseRules: b });
      expect(text(await page({ ...d, ports: d.ports.map((p) => ({ ...p, inForce: false })) }, m))).not.toMatch(KERNEL);
    }
  });
});
