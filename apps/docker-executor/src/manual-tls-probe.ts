import { connect } from "node:tls";

export const PROBE_INTERVAL_MS = 250 as const;
export const PROBE_DEADLINE_MS = 20_000 as const;
export const PROBE_CONNECT_TIMEOUT_MS = 3_000 as const;
const REQUIRED_CONSECUTIVE_MATCHES = 2;

/** `fingerprintSha256`: the host must serve exactly this; `notFingerprintSha256`: it must serve anything else. */
export type ServedExpectation =
  | { hostname: string; fingerprintSha256: string }
  | { hostname: string; notFingerprintSha256: string };

export interface ProbeEndpoint {
  host: string;
  port: number;
}

export interface WaitForServedOptions extends ProbeEndpoint {
  /** Tried for a poll when the primary endpoint refuses the connection. */
  fallback?: ProbeEndpoint;
  deadlineMs?: number;
  intervalMs?: number;
  connectTimeoutMs?: number;
}

export interface ServedReport {
  served: boolean;
  /** Last fingerprint seen per hostname (null: no TLS answer). */
  observed: Record<string, string | null>;
  /** Hostnames that did not reach the required consecutive matches. */
  unmatched: string[];
}

const normalizeFingerprint = (value: string): string => value.replaceAll(":", "").toLowerCase();

/** SHA-256 of the leaf certificate served for `servername`, lowercase hex without colons. */
export function probeServedFingerprint(
  host: string,
  port: number,
  servername: string,
  timeoutMs: number = PROBE_CONNECT_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, servername, rejectUnauthorized: false, timeout: timeoutMs });
    const fail = (error: Error): void => {
      socket.destroy();
      reject(error);
    };
    socket.once("secureConnect", () => {
      const fingerprint = socket.getPeerCertificate().fingerprint256;
      socket.end();
      if (fingerprint) resolve(normalizeFingerprint(fingerprint));
      else reject(new Error("no peer certificate"));
    });
    socket.once("timeout", () => fail(Object.assign(new Error("probe timeout"), { code: "ETIMEDOUT" })));
    socket.once("error", fail);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls until every expectation held for two consecutive polls, or the deadline passes.
 * A failed connection counts as "no match" (never as "not served" for notFingerprint).
 */
export async function waitForServed(
  expectations: readonly ServedExpectation[],
  options: WaitForServedOptions,
): Promise<ServedReport> {
  const intervalMs = options.intervalMs ?? PROBE_INTERVAL_MS;
  const deadline = Date.now() + (options.deadlineMs ?? PROBE_DEADLINE_MS);
  const connectTimeoutMs = options.connectTimeoutMs ?? PROBE_CONNECT_TIMEOUT_MS;
  const streaks = expectations.map(() => 0);
  const observed: Record<string, string | null> = {};

  const probe = async (servername: string): Promise<string | null> => {
    try {
      return await probeServedFingerprint(options.host, options.port, servername, connectTimeoutMs);
    } catch (error) {
      if (options.fallback && (error as NodeJS.ErrnoException).code === "ECONNREFUSED") {
        return probeServedFingerprint(
          options.fallback.host,
          options.fallback.port,
          servername,
          connectTimeoutMs,
        ).catch(() => null);
      }
      return null;
    }
  };

  for (;;) {
    const hostnames = [...new Set(expectations.map((e) => e.hostname))];
    const seen = new Map(await Promise.all(hostnames.map(async (h) => [h, await probe(h)] as const)));
    for (const [h, fingerprint] of seen) observed[h] = fingerprint;
    expectations.forEach((expectation, index) => {
      const fingerprint = seen.get(expectation.hostname) ?? null;
      const matched =
        fingerprint !== null &&
        ("fingerprintSha256" in expectation
          ? fingerprint === normalizeFingerprint(expectation.fingerprintSha256)
          : fingerprint !== normalizeFingerprint(expectation.notFingerprintSha256));
      streaks[index] = matched ? streaks[index]! + 1 : 0;
    });
    if (streaks.every((n) => n >= REQUIRED_CONSECUTIVE_MATCHES)) {
      return { served: true, observed, unmatched: [] };
    }
    if (Date.now() + intervalMs > deadline) {
      const unmatched = [
        ...new Set(
          expectations.filter((_, i) => streaks[i]! < REQUIRED_CONSECUTIVE_MATCHES).map((e) => e.hostname),
        ),
      ];
      return { served: false, observed, unmatched };
    }
    await sleep(intervalMs);
  }
}
