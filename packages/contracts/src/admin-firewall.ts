import { z } from "zod";

/** D9: the only ports the panel opens, by name; never 22, 80, 443, 3000, 4000, a database or a Docker port. */
export const FIREWALL_PORT_NAMES = ["http_alt", "https_alt", "node_exporter", "zabbix_agent", "checkmk_agent", "nrpe"] as const;
export type FirewallPortName = (typeof FIREWALL_PORT_NAMES)[number];
export const FirewallPortNameSchema = z.enum(FIREWALL_PORT_NAMES);
export const FIREWALL_SAFE_PORTS: Readonly<Record<FirewallPortName, number>> = Object.freeze({
  http_alt: 8080, https_alt: 8443, node_exporter: 9100, zabbix_agent: 10050, checkmk_agent: 6556, nrpe: 5666,
});

/** Static lines of infra/linux/nftables-dedicated.conf; a test compares the tcp dport numbers with the file. */
export const FIREWALL_STATIC_RULES = [
  { key: "ssh", ports: [22] }, { key: "web", ports: [80, 443] }, { key: "panel", ports: [3000] },
  { key: "icmp", ports: [] }, { key: "replies", ports: [] },
] as const;

export const FIREWALL_MAX_BLOCKS_PER_FAMILY = 500;
export const FIREWALL_ADDRESS_MAX = 64;
export const FIREWALL_NOTE_MAX = 200;
export const FIREWALL_MIN_PREFIX = { ipv4: 16, ipv6: 32 } as const;
export const FIREWALL_BLOCK_REFUSALS = ["invalid", "ipv4_mapped", "host_bits", "too_wide", "reserved", "own_address", "overlaps", "limit"] as const;
export type FirewallBlockRefusal = (typeof FIREWALL_BLOCK_REFUSALS)[number];
export const FIREWALL_FAMILIES = ["ipv4", "ipv6"] as const;
export type FirewallFamily = (typeof FIREWALL_FAMILIES)[number];
export type FirewallBlockCheck =
  | { readonly ok: true; readonly family: FirewallFamily; readonly cidr: string }
  | { readonly ok: false; readonly reason: FirewallBlockRefusal };

export const FIREWALL_BLOCK_ID_PATTERN = /^fwb_[0-9a-f]{32}$/;
// A note is shown to administrators only and never reaches the agent.
export const isFirewallNoteValid = (note: string): boolean => note.length <= FIREWALL_NOTE_MAX && !/[\p{Cc}\p{Cf}]/u.test(note);
export const FirewallBlockInputSchema = z.object({ address: z.string(), note: z.string().nullable().optional() }).strict();
export type FirewallBlockInput = z.infer<typeof FirewallBlockInputSchema>;

type Net = { family: FirewallFamily; value: bigint; len: number };
const BITS = { ipv4: 32, ipv6: 128 } as const;
const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const V4 = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`);
const LEN = /^(?:0|[1-9]\d{0,2})$/;

function v4(s: string): bigint | null {
  return V4.test(s) ? s.split(".").reduce((a, o) => (a << 8n) | BigInt(o), 0n) : null;
}

function v6(s: string): bigint | null {
  if (s.includes(".")) {
    // A dotted tail (64:ff9b::192.0.2.1) becomes its two hex groups.
    const at = s.lastIndexOf(":") + 1;
    const q = v4(s.slice(at));
    if (q === null) return null;
    s = `${s.slice(0, at)}${(q >> 16n).toString(16)}:${(q & 0xffffn).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const part = (h: string) => (h === "" ? [] : h.split(":"));
  const head = part(halves[0]!), rest = halves.length === 2 ? part(halves[1]!) : [];
  const all = [...head, ...rest];
  if (!all.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g)) || (halves.length === 1 ? all.length !== 8 : all.length > 7)) return null;
  const groups = [...head, ...Array<string>(8 - all.length).fill("0"), ...rest];
  return groups.reduce((a, g) => (a << 16n) | BigInt(`0x${g}`), 0n);
}

function parse(text: string): Net | null {
  const [addr, len, extra] = text.split("/");
  if (extra !== undefined || addr === undefined || (len !== undefined && !LEN.test(len))) return null;
  const four = v4(addr);
  const family: FirewallFamily = four !== null ? "ipv4" : "ipv6";
  const value = four ?? (addr.includes(":") ? v6(addr) : null);
  const l = len === undefined ? BITS[family] : Number(len);
  return value === null || l > BITS[family] ? null : { family, value, len: l };
}

const contains = (a: Net, b: Net) =>
  a.family === b.family && a.len <= b.len && a.value >> BigInt(BITS[a.family] - a.len) === b.value >> BigInt(BITS[a.family] - a.len);
const overlaps = (a: Net, b: Net) => contains(a, b) || contains(b, a);

const RESERVED = ["0.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16", "224.0.0.0/4", "::/96", "fe80::/10", "ff00::/8"].map((r) => parse(r)!);
const MAPPED = parse("::ffff:0:0/96")!;

function format(n: Net): string {
  if (n.family === "ipv4") {
    const a = [24n, 16n, 8n, 0n].map((s) => String((n.value >> s) & 0xffn)).join(".");
    return n.len === 32 ? a : `${a}/${n.len}`;
  }
  const g = Array.from({ length: 8 }, (_, i) => Number((n.value >> BigInt(112 - 16 * i)) & 0xffffn));
  let best = -1, bestLen = 1;
  for (let i = 0; i < 8; ) {
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen) [best, bestLen] = [i, j - i];
    i = j === i ? i + 1 : j;
  }
  const hex = (xs: number[]) => xs.map((x) => x.toString(16)).join(":");
  const a = best < 0 ? hex(g) : `${hex(g.slice(0, best))}::${hex(g.slice(best + bestLen))}`;
  return n.len === 128 ? a : `${a}/${n.len}`;
}

/** The block rule of D10, shared by the API and the host agent; the answer never echoes the input. */
export function checkFirewallBlock(
  input: string,
  context: { readonly stored: readonly string[]; readonly requesterAddress: string | null },
): FirewallBlockCheck {
  const no = (reason: FirewallBlockRefusal): FirewallBlockCheck => ({ ok: false, reason });
  const net = input.length > FIREWALL_ADDRESS_MAX ? null : parse(input);
  if (!net) return no("invalid");
  if (contains(MAPPED, net)) return no("ipv4_mapped");
  if (net.value & ((1n << BigInt(BITS[net.family] - net.len)) - 1n)) return no("host_bits");
  if (net.len < FIREWALL_MIN_PREFIX[net.family]) return no("too_wide");
  if (RESERVED.some((r) => overlaps(net, r))) return no("reserved");
  let me = context.requesterAddress === null ? null : parse(context.requesterAddress);
  if (me && contains(MAPPED, me)) me = { family: "ipv4", value: me.value & 0xffffffffn, len: 32 };
  if (me && me.len === BITS[me.family] && contains(net, me)) return no("own_address");
  const same = context.stored.map(parse).filter((s): s is Net => s !== null && s.family === net.family);
  if (same.some((s) => overlaps(net, s))) return no("overlaps");
  if (same.length >= FIREWALL_MAX_BLOCKS_PER_FAMILY) return no("limit");
  return { ok: true, family: net.family, cidr: format(net) };
}

const Iso = z.string().datetime({ offset: true });
export const FIREWALL_BASE_STATES = ["current", "outdated", "absent", "unreadable", "disabled", "unmanaged"] as const;
export const FirewallDtoSchema = z.object({
  baseRules: z.enum(FIREWALL_BASE_STATES),
  readAt: Iso.nullable(),
  hostId: z.string().nullable(),
  staticRules: z.array(z.object({ key: z.enum(["ssh", "web", "panel", "icmp", "replies"]), ports: z.array(z.number().int()) })),
  ports: z.array(z.object({ name: FirewallPortNameSchema, port: z.number().int(), open: z.boolean(), inForce: z.boolean().nullable() })),
  blocks: z.array(z.object({
    id: z.string().regex(FIREWALL_BLOCK_ID_PATTERN), address: z.string(), family: z.enum(FIREWALL_FAMILIES),
    note: z.string().nullable(), createdAt: Iso, inForce: z.boolean().nullable(),
  })),
});
export type FirewallDto = z.infer<typeof FirewallDtoSchema>;
