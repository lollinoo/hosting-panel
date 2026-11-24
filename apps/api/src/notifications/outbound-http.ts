// The only place where the API makes an HTTP request to the outside (ADR-0040 N7).
// One rule for every call, also the ones to Telegram: https only, to a DNS name whose every resolved address is public
// and is not one of this server's own (those of its interfaces and those the panel records for it); the connection
// goes to the address that was checked; no redirect is followed and the body of the answer is never read. Nothing here
// logs: an address often holds a key.
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { hosts, type HostingPanelDatabase } from "@hosting-panel/database";
import type { DnsLookup } from "../sites/dns-check.js";

export type OutboundProblem = "address_not_allowed" | "unreachable" | "redirect" | "rejected" | "server_error";

export interface OutboundResult {
  /** null: the other side answered 2xx. */
  readonly problem: OutboundProblem | null;
  readonly httpStatus: number | null;
}

export interface OutboundHttpPort {
  /** Whether the address may be called now: null, or why not. Nothing is sent. */
  check(url: string): Promise<OutboundProblem | null>;
  /** One POST of a JSON body. Never throws. */
  postJson(url: string, body: string, headers?: Readonly<Record<string, string>>): Promise<OutboundResult>;
}

/** Tests only. No environment variable sets any of these. */
export interface OutboundHttpTestOptions {
  /** Replaces the public-address rule (a test server listens on loopback). */
  readonly treatAsPublic?: (address: string) => boolean;
  /** Replaces the addresses of this server's interfaces. */
  readonly localAddresses?: () => readonly string[];
  /** A certificate authority to trust besides the system's. */
  readonly ca?: string | Buffer;
  readonly timeoutMs?: number;
}

/** One attempt in all: the resolution of the name and the exchange. */
export const OUTBOUND_TIMEOUT_MS = 5_000;
// Headers this module writes itself: a caller's header of the same name is dropped.
const OWN_HEADERS = new Set(["host", "content-type", "content-length", "transfer-encoding", "user-agent", "connection"]);

// IPv4 that is not a public unicast address: this network, private, shared by providers, loopback, link-local (the
// cloud metadata address is here), protocol assignments, documentation, benchmarking, multicast, reserved.
const DENIED_V4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
// IPv6 is public only inside 2000::/3, minus the special ranges there: protocol assignments (Teredo carries an IPv4
// inside), documentation, 6to4 (an IPv4 inside). Everything outside 2000::/3 is refused with it: loopback,
// IPv4-mapped and IPv4-compatible, NAT64, unique local, link-local, multicast.
const DENIED_V6: ReadonlyArray<readonly [string, number]> = [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]];

const deniedV4 = new BlockList();
for (const [net, prefix] of DENIED_V4) deniedV4.addSubnet(net, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const deniedV6 = new BlockList();
for (const [net, prefix] of DENIED_V6) deniedV6.addSubnet(net, prefix, "ipv6");

/** Whether an address, as text, is a public unicast address. Anything that is not an address is not. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !deniedV4.check(address, "ipv4");
  if (family === 6) return globalV6.check(address, "ipv6") && !deniedV6.check(address, "ipv6");
  return false;
}

/** The addresses of this server's network interfaces. */
function interfaceAddresses(): string[] {
  return Object.values(networkInterfaces()).flatMap((list) => (list ?? []).map((i) => i.address.split("%", 1)[0]!));
}

/** The public addresses the panel records for its servers: behind address translation no interface has them. */
export type RecordedAddresses = () => Promise<readonly string[]>;

/** Every IPv4 and IPv6 address of every host row. What is not an address is left to the check, which ignores it. */
export async function recordedServerAddresses(db: HostingPanelDatabase): Promise<string[]> {
  const rows = await db.select({ ipv4: hosts.ipv4Address, ipv6: hosts.ipv6Address }).from(hosts);
  return rows.flatMap((row) => (row.ipv6 === null ? [row.ipv4] : [row.ipv4, row.ipv6]));
}

interface Target {
  readonly url: URL;
  readonly name: string;
  readonly address: string;
}

const failed = (problem: OutboundProblem, httpStatus: number | null = null): OutboundResult => ({ problem, httpStatus });

/** What `work` gives, or null when `endsAt` comes first: a resolver that never answers does not hold the attempt. */
async function beforeEnd<T>(work: Promise<T>, endsAt: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const end = new Promise<null>((done) => {
    timer = setTimeout(() => done(null), Math.max(0, endsAt - Date.now()));
  });
  try {
    return await Promise.race([work, end]);
  } finally {
    clearTimeout(timer);
  }
}

function resultOf(status: number): OutboundResult {
  if (status >= 200 && status <= 299) return { problem: null, httpStatus: status };
  if (status >= 300 && status <= 399) return failed("redirect", status);
  if (status >= 500 && status <= 599) return failed("server_error", status);
  return failed("rejected", status >= 100 && status <= 599 ? status : null);
}

export function createOutboundHttp(dns: DnsLookup, recorded: RecordedAddresses, test: OutboundHttpTestOptions = {}): OutboundHttpPort {
  const timeoutMs = test.timeoutMs ?? OUTBOUND_TIMEOUT_MS;

  async function target(raw: string, endsAt: number): Promise<Target | OutboundProblem> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return "address_not_allowed";
    }
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return "address_not_allowed";
    const name = url.hostname;
    // A DNS name only: the URL parser has already turned every spelling of an IPv4 into dotted digits.
    if (name.startsWith("[") || isIP(name) !== 0 || !name.includes(".")) return "address_not_allowed";
    let found: { a: string[]; aaaa: string[] } | null;
    try {
      found = await beforeEnd(dns.lookup(name), endsAt);
    } catch {
      return "unreachable";
    }
    if (found === null) return "unreachable";
    const addresses = [...found.a, ...found.aaaa];
    if (addresses.length === 0) return "unreachable";
    // Read at every call, as the interfaces are: an address the installer records again counts at the next send.
    let kept: readonly string[] | null;
    try {
      kept = await beforeEnd(recorded(), endsAt);
    } catch {
      return "unreachable";
    }
    // Fail closed: nothing is called while it is not known which addresses are this server's.
    if (kept === null) return "unreachable";
    const own = new BlockList();
    for (const address of [...(test.localAddresses ? test.localAddresses() : interfaceAddresses()), ...kept]) {
      const family = isIP(address);
      if (family !== 0) own.addAddress(address, family === 4 ? "ipv4" : "ipv6");
    }
    // Every address, not only the one used: a name that also answers with a private address is refused whole.
    for (const address of addresses) {
      const family = isIP(address);
      if (family === 0) return "address_not_allowed";
      if (!(test.treatAsPublic ? test.treatAsPublic(address) : isPublicAddress(address))) return "address_not_allowed";
      if (own.check(address, family === 4 ? "ipv4" : "ipv6")) return "address_not_allowed";
    }
    // shortcut: one address is tried, IPv4 first; a name with several is not walked.
    return { url, name, address: addresses[0]! };
  }

  function send(to: Target, body: string, headers: Readonly<Record<string, string>>, endsAt: number): Promise<OutboundResult> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: OutboundResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve(result);
      };
      const req = request({
        // The checked address, never the name: a second resolution could lead elsewhere.
        host: to.address,
        port: to.url.port === "" ? 443 : Number(to.url.port),
        servername: to.name,
        method: "POST",
        path: `${to.url.pathname}${to.url.search}`,
        agent: false,
        headers: {
          ...Object.fromEntries(Object.entries(headers).filter(([name]) => !OWN_HEADERS.has(name.toLowerCase()))),
          Host: to.url.host,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "User-Agent": "hosting-panel",
          Connection: "close",
        },
        ...(test.ca !== undefined ? { ca: test.ca } : {}),
      });
      // What the resolution left of the one bound, also for a side that connects and then says nothing.
      const deadline = setTimeout(() => {
        req.destroy();
        finish(failed("unreachable"));
      }, Math.max(0, endsAt - Date.now()));
      req.on("response", (res) => {
        const status = res.statusCode ?? 0;
        // Only the class of the status counts: the body is never read.
        res.destroy();
        finish(resultOf(status));
      });
      req.on("error", () => finish(failed("unreachable")));
      req.end(body);
    });
  }

  return {
    async check(url) {
      const to = await target(url, Date.now() + timeoutMs);
      return typeof to === "string" ? to : null;
    },
    async postJson(url, body, headers = {}) {
      // One bound for the attempt, started before the name is resolved.
      const endsAt = Date.now() + timeoutMs;
      try {
        const to = await target(url, endsAt);
        return typeof to === "string" ? failed(to) : await send(to, body, headers, endsAt);
      } catch {
        return failed("unreachable");
      }
    },
  };
}
