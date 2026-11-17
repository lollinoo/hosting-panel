import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FIREWALL_MAX_BLOCKS_PER_FAMILY,
  FIREWALL_PORT_NAMES,
  FIREWALL_SAFE_PORTS,
  FIREWALL_STATIC_RULES,
  FirewallBlockInputSchema,
  checkFirewallBlock,
  isFirewallNoteValid,
  type FirewallBlockRefusal,
} from "../src/index.js";

const NONE = { stored: [], requesterAddress: null } as const;
type Ctx = { readonly stored: readonly string[]; readonly requesterAddress: string | null };

const v4s = (n: number) => Array.from({ length: n }, (_, i) => (i < 256 ? `192.0.2.${i}` : `198.51.100.${i - 256}`));
const v6s = (n: number) => Array.from({ length: n }, (_, i) => `2001:db8::${(i + 1).toString(16)}`);

const ACCEPTED: readonly (readonly [string, "ipv4" | "ipv6", string, Ctx?])[] = [
  ["192.0.2.1/32", "ipv4", "192.0.2.1"],
  ["192.0.2.1", "ipv4", "192.0.2.1"],
  ["198.51.100.0/24", "ipv4", "198.51.100.0/24"],
  ["203.0.113.0/24", "ipv4", "203.0.113.0/24", { stored: [], requesterAddress: "not-an-address" }],
  ["2001:0db8:0000:0000:0000:0000:0000:0001", "ipv6", "2001:db8::1"],
  ["2001:DB8::/32", "ipv6", "2001:db8::/32"],
  ["2001:db8:0:0:1:0:0:1", "ipv6", "2001:db8::1:0:0:1"],
  ["64:ff9b::192.0.2.1", "ipv6", "64:ff9b::c000:201"],
  ["2001:db8::1", "ipv6", "2001:db8::1", { stored: v4s(FIREWALL_MAX_BLOCKS_PER_FAMILY), requesterAddress: null }],
  ["203.0.113.1", "ipv4", "203.0.113.1", { stored: v6s(FIREWALL_MAX_BLOCKS_PER_FAMILY), requesterAddress: null }],
];

const REFUSED: readonly (readonly [string, FirewallBlockRefusal, Ctx?])[] = [
  ["192.0.2.01", "invalid"],
  ["192.0.2.1;flush ruleset", "invalid"],
  ["192.0.2.1 }; add rule", "invalid"],
  ["@blocked_v4", "invalid"],
  ["198.51.100.0/24,203.0.113.1", "invalid"],
  ["[2001:db8::1]", "invalid"],
  ["fe80::1%eth0", "invalid"],
  [`192.0.2.1/32${" ".repeat(53)}`, "invalid"],
  ["", "invalid"],
  ["192.0.2.256", "invalid"],
  ["192.0.2.1/33", "invalid"],
  ["192.0.2.0/024", "invalid"],
  ["192.0.2.0/24/1", "invalid"],
  ["2001:db8::1::2", "invalid"],
  ["2001:db8:1:2:3:4:5:6:7", "invalid"],
  ["2001:db8::/129", "invalid"],
  ["2001:db8::g", "invalid"],
  ["::ffff:192.0.2.1", "ipv4_mapped"],
  ["::ffff:c000:201", "ipv4_mapped"],
  ["192.0.2.5/24", "host_bits"],
  ["2001:db8::1/64", "host_bits"],
  ["10.0.0.0/8", "too_wide"],
  ["2001:db8::/31", "too_wide"],
  ["127.0.0.1", "reserved"],
  ["169.254.0.0/16", "reserved"],
  ["::/64", "reserved"],
  ["::/96", "reserved"],
  ["::102:300/120", "reserved"],
  ["::1.2.3.4", "reserved"],
  ["ff02::1", "reserved"],
  ["fe80::1", "reserved"],
  ["203.0.113.0/24", "own_address", { stored: [], requesterAddress: "::ffff:203.0.113.7" }],
  ["203.0.113.0/24", "own_address", { stored: [], requesterAddress: "203.0.113.7" }],
  ["2001:db8::/48", "own_address", { stored: [], requesterAddress: "2001:db8::7" }],
  ["198.51.100.7", "overlaps", { stored: ["198.51.100.0/24"], requesterAddress: null }],
  ["198.51.100.0/24", "overlaps", { stored: ["198.51.100.7"], requesterAddress: null }],
  ["2001:db8::1", "overlaps", { stored: ["2001:db8::/48"], requesterAddress: null }],
  ["2001:db8::/48", "overlaps", { stored: ["2001:db8::1"], requesterAddress: null }],
  ["203.0.113.1", "limit", { stored: v4s(FIREWALL_MAX_BLOCKS_PER_FAMILY), requesterAddress: null }],
  ["2001:db8::1:0", "limit", { stored: v6s(FIREWALL_MAX_BLOCKS_PER_FAMILY), requesterAddress: null }],
];

/** Distinct numeric tcp dport values of an nft ruleset; a set reference like @name is not a number. */
function tcpDports(text: string): number[] {
  const found = new Set<number>();
  for (const m of text.replace(/#.*$/gm, "").matchAll(/tcp dport (\{[^}]*\}|\d+)/g))
    for (const n of m[1]!.match(/\d+/g) ?? []) found.add(Number(n));
  return [...found].sort((a, b) => a - b);
}

describe("firewall block rule (D10)", () => {
  const accepted = ACCEPTED.map(([input, family, cidr, ctx]) => ({ input, family, cidr, ctx: ctx ?? NONE }));
  const refused = REFUSED.map(([input, reason, ctx]) => ({ input, reason, ctx: ctx ?? NONE }));

  it.each(accepted)("accepts $input", ({ input, family, cidr, ctx }) => {
    expect(checkFirewallBlock(input, ctx)).toEqual({ ok: true, family, cidr });
  });

  it.each(accepted)("gives back $input unchanged when its result is checked again", ({ input, ctx }) => {
    const first = checkFirewallBlock(input, ctx);
    expect(first.ok && checkFirewallBlock(first.cidr, ctx)).toEqual(first);
  });

  it.each(refused)("refuses $input as $reason and never echoes it", ({ input, reason, ctx }) => {
    const result = checkFirewallBlock(input, ctx);
    expect(result).toEqual({ ok: false, reason });
    if (input !== "") expect(JSON.stringify(result)).not.toContain(input);
  });

  it("takes a note of at most 200 characters without control characters", () => {
    expect(isFirewallNoteValid("a".repeat(200))).toBe(true);
    expect(isFirewallNoteValid("a".repeat(201))).toBe(false);
    expect(isFirewallNoteValid("scanner\nnext")).toBe(false);
    expect(isFirewallNoteValid("a‎b")).toBe(false);
    expect(FirewallBlockInputSchema.safeParse({ address: "192.0.2.1", note: null }).success).toBe(true);
    expect(FirewallBlockInputSchema.safeParse({ address: "192.0.2.1", extra: 1 }).success).toBe(false);
  });
});

describe("firewall lists (D9)", () => {
  it("opens no port the panel or a database needs", () => {
    expect(Object.keys(FIREWALL_SAFE_PORTS)).toEqual([...FIREWALL_PORT_NAMES]);
    for (const port of Object.values(FIREWALL_SAFE_PORTS))
      expect([22, 80, 443, 2222, 3000, 3306, 4000, 5432, 8306]).not.toContain(port);
  });

  it("names the static rules of the shipped ruleset", () => {
    const file = readFileSync(new URL("../../../infra/linux/nftables-dedicated.conf", import.meta.url), "utf8");
    const ports = [...new Set(FIREWALL_STATIC_RULES.flatMap((r) => [...r.ports]))].sort((a, b) => a - b);
    // The forward chain (R207 host.1) passes DNS for sites; it opens nothing towards the server.
    expect(tcpDports(file.replace(/chain forward \{[^}]*\}/, ""))).toEqual(ports);
    // The M5d ruleset adds a bare port and a set reference: the same numbers come out.
    const m5d = "tcp dport 22 accept\n tcp dport { 22, 80, 443 } ct state new accept\n tcp dport @opened_tcp_ports ct state new accept\n iifname \"br-*\" tcp dport 3000 ct state new accept\n";
    expect(tcpDports(m5d)).toEqual(ports);
  });
});
