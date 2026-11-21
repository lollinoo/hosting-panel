import {
  CERTIFICATE_ALERT_TIERS,
  certificateExpiryTier,
  type CertificateAlertTier,
  type TlsCertificateAlertDto,
} from "@hosting-panel/contracts";
import {
  and,
  appendAuditEvent,
  asc,
  auditEvents,
  domains,
  eq,
  sites,
  sql,
  tlsCertificateVersions,
  tlsCertificates,
  type HostingPanelDatabase,
} from "@hosting-panel/database";

const isAlertTier = (tier: string): tier is CertificateAlertTier => (CERTIFICATE_ALERT_TIERS as readonly string[]).includes(tier);

/**
 * One alert per active manual version with at least one domain on it, at tier warning (<=14 days), critical (<=7 days)
 * or expired. The 30-day notice tier belongs to the certificate pages and is dropped here. Computed on read: no event.
 */
export async function manualExpiryAlerts(db: HostingPanelDatabase, now: Date): Promise<TlsCertificateAlertDto[]> {
  const rows = await db
    .select({
      versionId: tlsCertificateVersions.id,
      certificateId: tlsCertificateVersions.certificateId,
      organizationId: tlsCertificateVersions.organizationId,
      notAfter: tlsCertificateVersions.notAfter,
      certificateName: tlsCertificates.name,
      hostname: domains.hostname,
      siteId: sites.id,
      siteName: sites.name,
    })
    .from(domains)
    .innerJoin(tlsCertificateVersions, eq(tlsCertificateVersions.id, domains.manualCertificateVersionId))
    .innerJoin(tlsCertificates, eq(tlsCertificates.id, tlsCertificateVersions.certificateId))
    .innerJoin(sites, eq(sites.id, domains.siteId))
    .where(and(eq(domains.certMode, "manual"), eq(tlsCertificateVersions.status, "active")))
    .orderBy(asc(tlsCertificateVersions.notAfter), asc(tlsCertificateVersions.id), asc(domains.hostname));

  const byVersion = new Map<string, TlsCertificateAlertDto>();
  for (const r of rows) {
    const existing = byVersion.get(r.versionId);
    if (existing) {
      existing.hostnames.push(r.hostname);
      // A certificate shared by several sites names none of them.
      if (existing.siteId !== r.siteId) Object.assign(existing, { siteId: null, siteName: null });
      continue;
    }
    const { tier, daysLeft } = certificateExpiryTier(r.notAfter, now);
    if (!isAlertTier(tier)) continue;
    byVersion.set(r.versionId, {
      certificateId: r.certificateId,
      certificateName: r.certificateName,
      versionId: r.versionId,
      organizationId: r.organizationId,
      siteId: r.siteId,
      siteName: r.siteName,
      hostnames: [r.hostname],
      notAfter: r.notAfter.toISOString(),
      tier,
      daysLeft,
    });
  }
  return [...byVersion.values()];
}

/**
 * Writes `site.tls_certificate.expiring` ({versionId, tier}) once per (version, warning|critical) and
 * `site.tls_certificate.expired` ({versionId}) once per version, as the system. A look into `audit_events` is the
 * only memory, so repeated ticks write nothing new. Called by the hourly tick, one at a time. Returns the rows written.
 */
export async function recordExpiryAudits(db: HostingPanelDatabase, now: Date): Promise<number> {
  let written = 0;
  for (const a of await manualExpiryAlerts(db, now)) {
    const expired = a.tier === "expired";
    const action = expired ? "site.tls_certificate.expired" : "site.tls_certificate.expiring";
    const tierMatch = expired ? sql`true` : sql`${auditEvents.details}->>'tier' = ${a.tier}`;
    const [seen] = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(and(eq(auditEvents.action, action), sql`${auditEvents.details}->>'versionId' = ${a.versionId}`, tierMatch))
      .limit(1);
    if (seen) continue;
    await appendAuditEvent(db, {
      actorType: "system",
      organizationId: a.organizationId,
      action,
      targetType: "tls_certificate",
      targetId: a.certificateId,
      details: expired ? { versionId: a.versionId } : { versionId: a.versionId, tier: a.tier },
    });
    written += 1;
  }
  return written;
}
