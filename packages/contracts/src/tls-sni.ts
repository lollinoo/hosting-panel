// Which certificate Traefik serves for an SNI name, and when a manual certificate is safe to publish.
// Pure TypeScript, no node: builtins (used by the API pre-check, the executor publish-time re-check and the browser).
// Model, proven on Traefik 3.7.19 (HCP-SPEC-004 arch-tls-ingress E1-E15): every certificate has a key =
// sorted names joined by ","; for an SNI name the candidates are the certificates with a matching name; the
// highest key (byte order) wins; equal keys are a random tie. "*" sorts below every hostname byte, so an exact
// ACME certificate always beats a manual wildcard.

export interface SniCertificate {
  readonly id: string;
  readonly source: "manual" | "acme";
  /** Lower-cased names exactly as Traefik holds them (see traefikCertificateNames). */
  readonly names: readonly string[];
}

/**
 * The names Traefik indexes a certificate by: the CN once, every DNS SAN that is not the CN, every IP.
 * The CN counts even when it is not a SAN (E13/E14).
 */
export function traefikCertificateNames(cert: {
  readonly commonName?: string | null;
  readonly dnsNames: readonly string[];
  readonly ipAddresses?: readonly string[];
}): string[] {
  const cn = cert.commonName ?? "";
  const names = cn === "" ? [] : [cn.toLowerCase()];
  for (const san of cert.dnsNames) if (san !== cn) names.push(san.toLowerCase());
  for (const ip of cert.ipAddresses ?? []) names.push(ip.toLowerCase());
  return names;
}

export function traefikCertificateKey(names: readonly string[]): string {
  return [...names].sort().join(",");
}

/** Traefik's matchDomain: exact, or a name with "*" replacing the leading labels one by one ("*.b.w", "*.*.w"). */
export function traefikNameMatches(hostname: string, name: string): boolean {
  const host = hostname.toLowerCase();
  const lowered = name.toLowerCase();
  if (host === lowered) return true;
  const cert = lowered.replace(/\.+$/, "");
  const labels = host.split(".");
  for (let i = 0; i < labels.length; i += 1) {
    labels[i] = "*";
    if (labels.join(".") === cert) return true;
  }
  return false;
}

export interface ServedCertificate {
  /** The unique certificate with the highest key; null when nothing matches or the top key is tied. */
  readonly winner: SniCertificate | null;
  /** Every certificate sharing the highest key when that is more than one (the served one is random). */
  readonly tie: readonly SniCertificate[];
}

export function servedCertificate(hostname: string, certs: readonly SniCertificate[]): ServedCertificate {
  let top: string | null = null;
  let best: SniCertificate[] = [];
  for (const cert of certs) {
    if (!cert.names.some((name) => traefikNameMatches(hostname, name))) continue;
    const key = traefikCertificateKey(cert.names);
    if (top === null || key > top) {
      top = key;
      best = [cert];
    } else if (key === top) {
      best.push(cert);
    }
  }
  if (best.length === 1) return { winner: best[0] ?? null, tie: [] };
  return { winner: null, tie: best };
}

export const SNI_VIOLATIONS = ["acme_eviction_required", "manual_overlap", "captures_host"] as const;
export type SniViolationKind = (typeof SNI_VIOLATIONS)[number];
export interface SniViolation {
  readonly kind: SniViolationKind;
  readonly hostname: string;
  /** The manual version the violation is about; null when it is a host that must stay off manual. */
  readonly versionId: string | null;
  /** Certificates in the way: ACME ids (acme_eviction_required) or manual version ids. */
  readonly blockerIds: readonly string[];
}

export interface ManualSniEntry {
  readonly versionId: string;
  readonly names: readonly string[];
  readonly assignedHosts: readonly string[];
}

export interface ManualSniPlan {
  readonly violations: readonly SniViolation[];
  /** ACME entries that must go for the plan to hold (all of them are named by an acme_eviction_required). */
  readonly evictAcmeIds: readonly string[];
  /** Names of evicted ACME entries that are not assigned here; they stay ACME and must pass R2 afterwards. */
  readonly collateralHosts: readonly string[];
}

const asManual = (entry: { readonly versionId: string; readonly names: readonly string[] }): SniCertificate => ({
  id: entry.versionId,
  source: "manual",
  names: entry.names.map((name) => name.toLowerCase()),
});

/** Manual certificates that would be served (alone or in a random tie) for a host that must stay off manual. */
function manualServing(hostname: string, certs: readonly SniCertificate[]): string[] {
  const { winner, tie } = servedCertificate(hostname, certs);
  return [...(winner ? [winner] : tie)].filter((cert) => cert.source === "manual").map((cert) => cert.id);
}

/**
 * HCP-SPEC-004 D6, for the full manual set about to be published.
 *  R1 a host assigned to V must be served by V alone: another manual entry in the way => manual_overlap,
 *     ACME entries only (higher key, or equal key = random tie) => acme_eviction_required.
 *  R2 a guard host (routed, not assigned, ACME mode, the panel host, evicted collateral) must not be served by
 *     a manual entry => captures_host.
 *  R3 two manual entries with the same key => manual_overlap.
 * A beaten ACME entry is fine. Coverage of an assigned host by its own version is the caller's check.
 */
export function planManualCertificates(input: {
  readonly entries: readonly ManualSniEntry[];
  readonly acme: readonly SniCertificate[];
  readonly guardHosts: readonly string[];
}): ManualSniPlan {
  const manual = input.entries.map(asManual);
  const violations: SniViolation[] = [];
  const seen = new Set<string>();
  const push = (violation: SniViolation): void => {
    const id = `${violation.kind}\u0000${violation.hostname}\u0000${violation.versionId ?? ""}`;
    if (seen.has(id)) return;
    seen.add(id);
    violations.push(violation);
  };
  const assigned = new Set(input.entries.flatMap((entry) => entry.assignedHosts.map((host) => host.toLowerCase())));
  const evict = new Set<string>();

  // R3
  const byKey = new Map<string, SniCertificate[]>();
  for (const cert of manual) {
    const key = traefikCertificateKey(cert.names);
    byKey.set(key, [...(byKey.get(key) ?? []), cert]);
  }
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    for (const cert of group) {
      const hostname = input.entries.find((entry) => entry.versionId === cert.id)?.assignedHosts[0] ?? "";
      push({ kind: "manual_overlap", hostname, versionId: cert.id, blockerIds: group.filter((o) => o !== cert).map((o) => o.id) });
    }
  }

  // R1
  for (const entry of input.entries) {
    const me = manual.find((cert) => cert.id === entry.versionId);
    if (!me) continue;
    const myKey = traefikCertificateKey(me.names);
    for (const host of entry.assignedHosts) {
      if (!me.names.some((name) => traefikNameMatches(host, name))) continue;
      const blockers = [...manual, ...input.acme].filter(
        (cert) => cert !== me && cert.names.some((name) => traefikNameMatches(host, name)) && traefikCertificateKey(cert.names) >= myKey,
      );
      const manualBlockers = blockers.filter((cert) => cert.source === "manual").map((cert) => cert.id);
      const acmeBlockers = blockers.filter((cert) => cert.source === "acme").map((cert) => cert.id);
      if (manualBlockers.length > 0) {
        push({ kind: "manual_overlap", hostname: host, versionId: entry.versionId, blockerIds: [...manualBlockers, ...acmeBlockers] });
      } else if (acmeBlockers.length > 0) {
        push({ kind: "acme_eviction_required", hostname: host, versionId: entry.versionId, blockerIds: acmeBlockers });
        for (const id of acmeBlockers) evict.add(id);
      }
    }
  }

  // Evicted entries leave acme.json: their other names fall back to ACME and become guard hosts.
  const remaining = input.acme.filter((cert) => !evict.has(cert.id));
  const collateral = new Set<string>();
  for (const cert of input.acme) {
    if (!evict.has(cert.id)) continue;
    for (const name of cert.names) {
      const host = name.toLowerCase();
      if (!host.startsWith("*") && !assigned.has(host)) collateral.add(host);
    }
  }

  // R2
  const guards = new Set([...input.guardHosts.map((host) => host.toLowerCase()), ...collateral]);
  for (const host of guards) {
    if (assigned.has(host)) continue;
    const capturing = manualServing(host, [...manual, ...remaining]);
    if (capturing.length > 0) push({ kind: "captures_host", hostname: host, versionId: capturing[0] ?? null, blockerIds: capturing });
  }

  return { violations, evictAcmeIds: [...evict].sort(), collateralHosts: [...collateral].sort() };
}

/**
 * Manual entries that would be served for `hostname` if it ran in ACME mode (new domain, or back to ACME): a
 * loaded wildcard blocks ACME orders for a new sibling (E6/E12), while an existing exact ACME certificate
 * keeps winning and renewing (E5/E7). Empty = safe.
 */
export function findManualCaptures(
  hostname: string,
  entries: readonly { readonly versionId: string; readonly names: readonly string[] }[],
  acme: readonly SniCertificate[],
): readonly string[] {
  return manualServing(hostname, [...entries.map(asManual), ...acme]);
}
