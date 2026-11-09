// shortcut: certificates of removed domains stay in acme.json and keep being renewed;
// upgrade is a cleanup with the proxy stopped, in a later step.
import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { redactSensitiveString, type CertProblem } from "@hosting-panel/contracts";
import type {
  AcmeFailure,
  CertificateStatusReport,
  StoredCertificate,
} from "@hosting-panel/executor-contracts";

interface StoreEntry {
  domain?: { main?: unknown };
  certificate?: unknown;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function readAcmeCertificates(
  storePath: string,
  resolver = "le",
): Promise<CertificateStatusReport> {
  let parsed: unknown;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const text = await readFile(storePath, "utf8");
      // An empty file (Traefik rewrites in place) fails to parse, so it reads as unreadable.
      parsed = JSON.parse(text);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { readable: true, certificates: [] };
      if (code === "EACCES" || attempt >= 1) return { readable: false, certificates: [] };
      await sleep(200);
    }
  }
  const entries = (parsed as Record<string, { Certificates?: unknown } | null> | null)?.[resolver]
    ?.Certificates;
  const certificates: StoredCertificate[] = [];
  if (Array.isArray(entries)) {
    for (const entry of entries as StoreEntry[]) {
      try {
        if (typeof entry.domain?.main !== "string" || typeof entry.certificate !== "string") continue;
        const pem = Buffer.from(entry.certificate, "base64").toString("utf8");
        const cert = new X509Certificate(pem); // leaf comes first
        certificates.push({
          hostname: entry.domain.main,
          notAfter: cert.validToDate.toISOString(),
          serialNumber: cert.serialNumber,
        });
      } catch {
        return { readable: false, certificates: [] };
      }
    }
  }
  return { readable: true, certificates };
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

export function parseAcmeFailures(lines: readonly string[], sinceMs: number): AcmeFailure[] {
  const out: AcmeFailure[] = [];
  for (const line of lines) {
    let entry: { time?: unknown; message?: unknown; error?: unknown; domains?: unknown };
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
    for (const hostname of hostnames) {
      out.push({
        hostname,
        at: new Date(at).toISOString(),
        kind,
        problem: classifyAcmeError(error),
        detail: redactSensitiveString(error).slice(0, 1024),
      });
    }
  }
  return out;
}
