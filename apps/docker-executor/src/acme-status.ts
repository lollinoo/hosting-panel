// shortcut: certificates of removed domains stay in acme.json and keep being renewed;
// upgrade is a cleanup with the proxy stopped, in a later step.
import { X509Certificate, randomBytes } from "node:crypto";
import { chmod, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  redactSensitiveString,
  traefikCertificateNames,
  traefikNameMatches,
  type CertProblem,
} from "@hosting-panel/contracts";
import type {
  AcmeFailure,
  AcmeStoreRead,
  StoredCertificate,
} from "@hosting-panel/executor-contracts";

interface StoreEntry {
  domain?: { main?: unknown; sans?: unknown };
  certificate?: unknown;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function readAcmeCertificates(
  storePath: string,
  resolvers: readonly string[] = ["le", "le-dns"],
): Promise<AcmeStoreRead> {
  let parsed: unknown;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const text = await readFile(storePath, "utf8");
      // An empty file (Traefik rewrites in place) fails to parse, so it reads as unreadable.
      parsed = JSON.parse(text);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "ENOENT" || attempt >= 1) return { readable: false, certificates: [] };
      await sleep(200);
    }
  }
  const byHost = new Map<string, StoredCertificate>();
  for (const resolver of resolvers) {
    const entries = (parsed as Record<string, { Certificates?: unknown } | null> | null)?.[resolver]
      ?.Certificates;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries as StoreEntry[]) {
      try {
        if (typeof entry.domain?.main !== "string" || typeof entry.certificate !== "string") continue;
        const pem = Buffer.from(entry.certificate, "base64").toString("utf8");
        const cert = new X509Certificate(pem); // leaf comes first
        const notAfter = cert.validToDate.toISOString();
        const sans = Array.isArray(entry.domain.sans) ? entry.domain.sans : [];
        for (const hostname of [entry.domain.main, ...sans]) {
          if (typeof hostname !== "string") continue;
          const seen = byHost.get(hostname);
          if (seen && seen.notAfter >= notAfter) continue; // ISO strings sort by time
          byHost.set(hostname, { hostname, notAfter, serialNumber: cert.serialNumber });
        }
      } catch {
        return { readable: false, certificates: [] };
      }
    }
  }
  return { readable: true, certificates: [...byHost.values()] };
}

export interface AcmeStoreEntry {
  /** `<resolver>#<index>` in that resolver's Certificates array. Valid for one read of the store. */
  readonly id: string;
  readonly resolver: string;
  readonly main: string;
  /** Traefik's names of the leaf (CN once, then DNS SANs, then IPs), lower-cased. */
  readonly names: readonly string[];
  readonly notAfter: string;
}

export interface AcmeStoreEntries {
  readable: boolean;
  entries: AcmeStoreEntry[];
}

export interface AcmeEviction {
  /** Null when no entry matched: the store is then left untouched. */
  readonly backupPath: string | null;
  readonly evicted: readonly { id: string; resolver: string; main: string; names: readonly string[] }[];
  /** Names of evicted entries that no requested hostname covers: ACME orders them again at start. */
  readonly collateralHosts: readonly string[];
}

/** The ACME store cannot be trusted (unreadable, unparsable, or an entry whose leaf does not parse). */
export class AcmeStoreError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AcmeStoreError";
  }
}

const KEEP_EVICTION_BACKUPS = 5;

/** The leaf's names as Traefik indexes it (traefikCertificateNames): the CN even when it is not a SAN. */
function leafNames(cert: X509Certificate): string[] {
  const cn = /^CN=(.*)$/m.exec(cert.subject)?.[1] ?? "";
  const dnsNames: string[] = [];
  const ipAddresses: string[] = [];
  const san = /(?:^|, )(DNS|IP Address):("(?:[^"\\]|\\.)*"|[^,]*)/g;
  for (const m of (cert.subjectAltName ?? "").matchAll(san)) {
    const raw = m[2]!;
    (m[1] === "DNS" ? dnsNames : ipAddresses).push(raw.startsWith('"') ? (JSON.parse(raw) as string) : raw);
  }
  return traefikCertificateNames({ commonName: cn, dnsNames, ipAddresses });
}

interface LoadedStore {
  raw: Buffer;
  parsed: Record<string, { Certificates?: unknown } | null>;
  entries: AcmeStoreEntry[];
}

/** One read, no retry: strict, the caller has the proxy stopped. Messages never carry store content. */
async function loadStore(storePath: string, resolvers: readonly string[]): Promise<LoadedStore | "missing"> {
  let raw: Buffer;
  try {
    raw = await readFile(storePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw new AcmeStoreError("ACME store unreadable");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new AcmeStoreError("ACME store is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AcmeStoreError("ACME store has an unexpected shape");
  }
  const store = parsed as LoadedStore["parsed"];
  const entries: AcmeStoreEntry[] = [];
  for (const resolver of resolvers) {
    const certificates = store[resolver]?.Certificates;
    if (certificates === undefined || certificates === null) continue;
    if (!Array.isArray(certificates)) throw new AcmeStoreError("ACME store has an unexpected shape");
    certificates.forEach((item: StoreEntry | null, index) => {
      if (typeof item?.certificate !== "string") return; // nothing Traefik could serve
      try {
        const cert = new X509Certificate(Buffer.from(item.certificate, "base64").toString("utf8")); // leaf first
        const names = leafNames(cert);
        const main = typeof item.domain?.main === "string" ? item.domain.main : (names[0] ?? "");
        entries.push({
          id: `${resolver}#${index}`,
          resolver,
          main,
          names,
          notAfter: cert.validToDate.toISOString(),
        });
      } catch {
        throw new AcmeStoreError(`ACME store entry ${resolver}#${index} has an unparsable certificate`);
      }
    });
  }
  return { raw, parsed: store, entries };
}

/** Entries of the resolvers' certificates; an unreadable or unparsable store is `readable:false`, never empty. */
export async function readAcmeStoreEntries(
  storePath: string,
  resolvers: readonly string[] = ["le", "le-dns"],
): Promise<AcmeStoreEntries> {
  try {
    const store = await loadStore(storePath, resolvers);
    return store === "missing" ? { readable: false, entries: [] } : { readable: true, entries: store.entries };
  } catch (error) {
    if (error instanceof AcmeStoreError) return { readable: false, entries: [] };
    throw error;
  }
}

/**
 * Cold eviction of the entries whose names cover one of `hostnames`: timestamped 0600 backup, then an atomic
 * 0600 rewrite without them. PRECONDITION: the ingress proxy is stopped (Traefik rewrites this file in place
 * and would undo or corrupt the edit); the caller enforces it. Throws AcmeStoreError, writing nothing, when the
 * store cannot be parsed in full. A missing store or no match writes nothing.
 */
export async function evictAcmeEntries(
  storePath: string,
  hostnames: readonly string[],
  now: Date,
  resolvers: readonly string[] = ["le", "le-dns"],
): Promise<AcmeEviction> {
  const store = await loadStore(storePath, resolvers);
  const none: AcmeEviction = { backupPath: null, evicted: [], collateralHosts: [] };
  if (store === "missing") return none;
  const hosts = hostnames.map((h) => h.toLowerCase());
  const evicted = store.entries.filter((e) => e.names.some((name) => hosts.some((h) => traefikNameMatches(h, name))));
  if (evicted.length === 0) return none;

  const stamp = now.toISOString().replace(/[-:]|\.\d+/g, ""); // 20261121T101530Z
  const baseName = path.basename(storePath);
  const dir = path.dirname(storePath);
  const backupPath = path.join(dir, `${baseName}.hp-evict-${stamp}.bak`);
  await writeFile(backupPath, store.raw, { mode: 0o600, flag: "wx" });
  await chmod(backupPath, 0o600); // umask-proof
  const drop = new Set(evicted.map((e) => e.id));
  for (const resolver of resolvers) {
    const certificates = store.parsed[resolver]?.Certificates;
    if (Array.isArray(certificates)) {
      store.parsed[resolver]!.Certificates = certificates.filter((_, index) => !drop.has(`${resolver}#${index}`));
    }
  }
  const tmpPath = path.join(dir, `.${baseName}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmpPath, JSON.stringify(store.parsed, null, 2), { mode: 0o600 });
    await chmod(tmpPath, 0o600);
    await rename(tmpPath, storePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
  await pruneEvictionBackups(dir, baseName);

  const collateral = new Set<string>();
  for (const e of evicted) {
    for (const name of e.names) if (!hosts.some((h) => traefikNameMatches(h, name))) collateral.add(name);
  }
  return {
    backupPath,
    evicted: evicted.map(({ id, resolver, main, names }) => ({ id, resolver, main, names })),
    collateralHosts: [...collateral],
  };
}

async function pruneEvictionBackups(dir: string, baseName: string): Promise<void> {
  const own = new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.hp-evict-\\d{8}T\\d{6}Z\\.bak$`);
  const names = (await readdir(dir)).filter((f) => own.test(f)).sort(); // the stamp sorts by time
  for (const old of names.slice(0, Math.max(0, names.length - KEEP_EVICTION_BACKUPS))) {
    await rm(path.join(dir, old), { force: true }).catch(() => undefined);
  }
}

export function classifyAcmeError(text: string): CertProblem {
  const lower = text.toLowerCase();
  if (text.includes("rateLimited")) return "rate_limited";
  if (text.includes(":caa")) return "caa_blocked";
  if (
    text.includes(":connection") ||
    lower.includes("timeout during connect") ||
    lower.includes("connection refused")
  ) {
    return "port_80_blocked";
  }
  if (text.includes(":unauthorized") || text.includes(":dns") || text.includes(":incorrectResponse")) {
    return "not_pointing";
  }
  return "other";
}

function classifyDnsAcmeError(text: string): CertProblem {
  if (text.includes("rateLimited")) return "rate_limited";
  if (text.includes(":caa")) return "caa_blocked";
  return "dns_provider";
}

export function parseAcmeFailures(
  lines: readonly string[],
  sinceMs: number,
  secrets: readonly string[] = [],
): AcmeFailure[] {
  const out: AcmeFailure[] = [];
  for (const line of lines) {
    let entry: {
      time?: unknown;
      message?: unknown;
      error?: unknown;
      domains?: unknown;
      providerName?: unknown;
    };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const { message, time } = entry;
    if (typeof message !== "string" || typeof time !== "string") continue;
    const at = Date.parse(time);
    if (Number.isNaN(at) || at < sinceMs) continue;
    const error = typeof entry.error === "string" ? entry.error : "";
    let kind: "obtain" | "renew";
    let hostnames: string[];
    if (message.startsWith("Unable to obtain ACME certificate")) {
      kind = "obtain";
      hostnames = Array.isArray(entry.domains)
        ? entry.domains.filter((d): d is string => typeof d === "string")
        : [];
    } else if (message.startsWith("Error renewing ACME certificate")) {
      kind = "renew";
      const host = /\{([^\s[\]{}]+)/.exec(message)?.[1];
      hostnames = host ? [host] : [];
    } else {
      continue;
    }
    const problem = entry.providerName === "le-dns.acme" ? classifyDnsAcmeError(error) : classifyAcmeError(error);
    // Longest first, so a credential that contains a shorter one is removed whole.
    const unsecret = [...secrets]
      .sort((a, b) => b.length - a.length)
      .reduce((text, s) => (s.length >= 4 ? text.split(s).join("[REDACTED]") : text), error);
    const detail = redactSensitiveString(unsecret).slice(0, 1024);
    for (const hostname of hostnames) {
      out.push({
        hostname,
        at: new Date(at).toISOString(),
        kind,
        problem,
        detail,
      });
    }
  }
  return out;
}
