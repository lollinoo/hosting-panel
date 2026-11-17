import { FIREWALL_SAFE_PORTS, HostFirewallSetsIpcSchema, checkFirewallBlock } from "@hosting-panel/contracts";
import type { HostFirewallSets, HostFirewallState } from "@hosting-panel/host-agent-contracts";
import { hostToolFailed } from "./host-parsers.js";
import { HostPolicyDeniedError } from "./nftables-baseline.js";

export const FIREWALL_TABLE = "inet hp_dedicated_filter";
const SETS = { openedPorts: "opened_tcp_ports", blockedV4: "blocked_v4", blockedV6: "blocked_v6" } as const;

/** Re-checks every entry with B1's rule; throws HostPolicyDeniedError before nft runs. */
export function validateFirewallSets(input: unknown): HostFirewallSets {
  const p = HostFirewallSetsIpcSchema.safeParse(input);
  if (!p.success) throw new HostPolicyDeniedError("Firewall lists refused");
  const { openedPorts, blockedV4, blockedV6 } = p.data;
  const safe: readonly number[] = Object.values(FIREWALL_SAFE_PORTS);
  if (new Set(openedPorts).size !== openedPorts.length || !openedPorts.every((n) => safe.includes(n)))
    throw new HostPolicyDeniedError("Firewall lists refused");
  for (const [list, family] of [[blockedV4, "ipv4"], [blockedV6, "ipv6"]] as const)
    list.forEach((el, i) => {
      const r = checkFirewallBlock(el, { stored: list.slice(0, i), requesterAddress: null });
      if (!r.ok || r.cidr !== el || r.family !== family) throw new HostPolicyDeniedError("Firewall lists refused");
    });
  return { openedPorts, blockedV4, blockedV6 };
}

/** One nft transaction: flush the three sets, then add the non-empty lists. */
export function buildFirewallSetsProgram(sets: HostFirewallSets): string {
  const lines = Object.values(SETS).map((s) => `flush set ${FIREWALL_TABLE} ${s}`);
  for (const key of Object.keys(SETS) as (keyof typeof SETS)[])
    if (sets[key].length > 0) lines.push(`add element ${FIREWALL_TABLE} ${SETS[key]} { ${sets[key].join(", ")} }`);
  return `${lines.join("\n")}\n`;
}

const SET_TYPES = { openedPorts: "inet_service", blockedV4: "ipv4_addr", blockedV6: "ipv6_addr" } as const;

/** Reads `nft -j list table`: outdated without the three typed sets or the forward chain, refuses any other element shape. */
export function parseFirewallListing(stdout: string): Omit<HostFirewallState, "readAt"> {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    throw hostToolFailed();
  }
  const items = (doc as { nftables?: unknown } | null)?.nftables;
  if (!Array.isArray(items)) throw hostToolFailed();
  const found = new Map<string, { type?: unknown; elem?: unknown }>();
  let forward = false;
  for (const item of items as Array<{ set?: { name?: unknown; table?: unknown; type?: unknown; elem?: unknown }; chain?: { name?: unknown; table?: unknown } } | null>) {
    if (item?.set && item.set.table === "hp_dedicated_filter" && typeof item.set.name === "string") found.set(item.set.name, item.set);
    if (item?.chain?.table === "hp_dedicated_filter" && item.chain.name === "forward") forward = true;
  }
  const keys = Object.keys(SETS) as (keyof typeof SETS)[];
  if (!forward || !keys.every((k) => found.get(SETS[k])?.type === SET_TYPES[k]))
    return { baseRules: "outdated", openedPorts: [], blockedV4: [], blockedV6: [] };
  const elems = (k: keyof typeof SETS): unknown[] => {
    const elem = found.get(SETS[k])!.elem ?? [];
    if (!Array.isArray(elem)) throw hostToolFailed();
    return elem;
  };
  const openedPorts = elems("openedPorts").map((e) => {
    if (!Number.isInteger(e) || (e as number) < 1 || (e as number) > 65535) throw hostToolFailed();
    return e as number;
  });
  const address = (e: unknown): string => {
    if (typeof e === "string") return e;
    const p = (e as { prefix?: { addr?: unknown; len?: unknown } } | null)?.prefix;
    if (p && typeof p.addr === "string" && Number.isInteger(p.len)) return `${p.addr}/${String(p.len)}`;
    throw hostToolFailed();
  };
  return {
    baseRules: "current",
    openedPorts: openedPorts.sort((a, b) => a - b),
    blockedV4: elems("blockedV4").map(address).sort(),
    blockedV6: elems("blockedV6").map(address).sort(),
  };
}
