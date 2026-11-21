import { Inject, Injectable } from "@nestjs/common";
import {
  OPERATION_TERMINAL_STATUSES,
  certificateExpiryTier,
  traefikNameMatches,
  type ActivateTlsVersionRequest,
  type AdminActivateTlsVersionRequest,
  type AdminSetDomainTlsRequest,
  type AdminTlsInventoryItemDto,
  type AdminTlsInventoryQuery,
  type CertChallenge,
  type CreateTlsCertificateVersionRequest,
  type ImportTlsCertificateRequest,
  type SetDomainTlsRequest,
  type SiteDomainsDto,
  type TlsCertificateAlertDto,
  type TlsCertificateDto,
  type TlsCertificateVersionDto,
  type TlsCertificateWarning,
} from "@hosting-panel/contracts";
import {
  TlsRepositoryError,
  and,
  asc,
  bumpTlsDesiredGeneration,
  deleteTlsCertificate,
  domains,
  eq,
  getTlsCertificate,
  auditEvents,
  gt,
  inArray,
  insertTlsCertificateWithVersion,
  insertTlsCertificateVersion,
  isNull,
  listTlsCertificatesForOrganization,
  lockTlsPublishState,
  not,
  operations,
  organizations,
  outboxEvents,
  sites,
  sql,
  tlsCertificateVersions,
  tlsCertificates,
  users,
  type DatabaseClient,
  type DatabaseExecutor,
  type TlsCertificateRecord,
  type TlsVersionRecord,
} from "@hosting-panel/database";
import { ControlPlaneError } from "../common/control-plane.error.js";
import { canonicalRequestHash } from "../common/request-hash.js";
import { CONTROL_PLANE_CONFIG_TOKEN, DATABASE_CLIENT_TOKEN, type ControlPlaneRuntimeConfig } from "../tokens.js";
import { SiteDomainsService } from "../sites/site-domains.service.js";
import { checkAssignment, enqueueSiteTlsOperation, type TlsChange } from "./tls-assignment.js";
import { TlsCertificateValidator, TlsValidationGate } from "./tls-certificate-validator.js";
import { manualExpiryAlerts } from "./tls-expiry.js";

// HCP-SPEC-004: the certificates service behind the customer and administrator routes. It validates and stores an
// imported certificate (a `pending` version, no operation), answers the DTOs, queues the `site.tls.apply` run through
// tls-assignment, deletes, and builds the administrator's inventory and alerts. Authorisation happens in the
// controllers, before any call here; every lookup here is id AND organisation (404 otherwise). A PEM, a private key or
// a parser message never leaves this module: refusals are ControlPlaneErrors with fixed texts.

export const TLS_VERSIONS_PER_HOUR = 10;
export const TLS_CERTIFICATES_PER_ORGANIZATION = 100;
export const TLS_VERSIONS_PER_CERTIFICATE = 20;
const HOUR_MS = 3_600_000;
const NOT_FOUND_MESSAGE = "Requested organization or resource was not found.";

/** Writes one audit row (the controller adds actor, request context and organisation). */
export type TlsAuditFn = (event: {
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly details: Record<string, unknown>;
}) => Promise<void>;

export interface TlsActor {
  readonly userId: string;
  /** A customer: the hourly version cap applies. A platform administrator is not capped. */
  readonly capped: boolean;
}

export interface TlsScope {
  readonly organizationId: string;
  readonly siteId: string;
}

/** What a change request did: `queued` is false for a no-op or a replay (answer 202 without a new operation). */
export interface TlsChangeResult {
  /** The domains of the requesting site. */
  readonly data: SiteDomainsDto;
  readonly queued: boolean;
  /** Every domain this request moves, on any site of the organisation (empty for a no-op or a replay). */
  readonly moved: readonly { readonly domainId: string; readonly siteId: string; readonly hostname: string }[];
}

interface Eviction {
  readonly confirmHostname: string;
}

const notFound = (): ControlPlaneError => new ControlPlaneError("NOT_FOUND", NOT_FOUND_MESSAGE);
const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());
const wildcardOf = (names: readonly string[]): boolean => names.some((name) => name.startsWith("*."));

/** Repository refusals → public errors, with fixed texts. */
function repositoryError(err: unknown): unknown {
  if (!(err instanceof TlsRepositoryError)) return err;
  switch (err.code) {
    case "ALREADY_EXISTS":
      return new ControlPlaneError("ALREADY_EXISTS", "This certificate is already imported.", {
        details: [
          {
            field: "leafPem",
            reason: "duplicate_certificate",
            // Same organisation only (the unique index is per organisation): the id of the existing certificate.
            message: err.existing?.certificateId ?? "This certificate is already imported.",
          },
        ],
      });
    case "IDEMPOTENCY_CONFLICT":
      return new ControlPlaneError("IDEMPOTENCY_CONFLICT", "The idempotency key was already used for a different request.");
    case "NOT_FOUND":
      return notFound();
    case "CERTIFICATE_IN_USE":
      return inUse();
    default:
      return err;
  }
}

const inUse = (): ControlPlaneError =>
  new ControlPlaneError("CERTIFICATE_IN_USE", "The certificate is in use. Move its web addresses to another certificate first.");

const versionDto = (v: TlsVersionRecord): TlsCertificateVersionDto => ({
  id: v.id,
  versionNumber: v.versionNumber,
  status: v.status,
  subject: v.subject,
  issuer: v.issuer,
  sanDns: v.sanDns,
  wildcard: wildcardOf(v.sanDns),
  notBefore: v.notBefore.toISOString(),
  notAfter: v.notAfter.toISOString(),
  serialNumber: v.serialNumber,
  fingerprintSha256: v.fingerprintSha256,
  keyType: v.keyType,
  keyBits: v.keyBits,
  createdAt: v.createdAt.toISOString(),
  activatedAt: iso(v.activatedAt),
  problem: v.lastErrorCode,
});

/** The version whose dates describe the certificate: the active one, else the newest. */
function currentVersion(record: TlsCertificateRecord): TlsVersionRecord | undefined {
  return record.versions.find((v) => v.id === record.activeVersionId) ?? record.versions[record.versions.length - 1];
}

interface OrgDomain {
  readonly id: string;
  readonly hostname: string;
  readonly siteId: string;
  readonly certMode: string;
  readonly manualVersionId: string | null;
}

function certificateDto(
  record: TlsCertificateRecord,
  orgDomains: readonly OrgDomain[],
  siteNames: ReadonlyMap<string, string>,
  now: Date,
): TlsCertificateDto {
  const versionIds = new Set(record.versions.map((v) => v.id));
  const covered = orgDomains
    .filter((d) => record.versions.some((v) => v.sanDns.some((name) => traefikNameMatches(d.hostname, name))))
    .sort((a, b) => a.hostname.localeCompare(b.hostname));
  const assignedTo = (d: OrgDomain): string | null =>
    d.certMode === "manual" && d.manualVersionId !== null && versionIds.has(d.manualVersionId) ? d.manualVersionId : null;
  const assigned = orgDomains
    .filter((d) => assignedTo(d) !== null)
    .sort((a, b) => a.hostname.localeCompare(b.hostname));

  const current = currentVersion(record);
  const expiry = current ? certificateExpiryTier(current.notAfter, now) : null;
  const warnings: TlsCertificateWarning[] = [];
  if (expiry?.tier === "warning" || expiry?.tier === "critical") warnings.push("expiring");
  if (expiry?.tier === "expired") warnings.push("expired");
  if (covered.some((d) => assignedTo(d) === null)) warnings.push("covers_unassigned_domains");

  return {
    id: record.id,
    name: record.name,
    source: "manual",
    createdForSiteId: record.createdForSiteId,
    activeVersionId: record.activeVersionId,
    versions: record.versions.map(versionDto),
    coveredDomains: covered.map((d) => ({
      domainId: d.id,
      hostname: d.hostname,
      assigned: assignedTo(d) !== null,
      versionId: assignedTo(d),
    })),
    assignedDomains: assigned.map((d) => ({
      domainId: d.id,
      siteId: d.siteId,
      siteName: siteNames.get(d.siteId) ?? "",
      hostname: d.hostname,
      versionId: assignedTo(d)!,
    })),
    expiry: expiry ? { tier: expiry.tier, daysLeft: expiry.daysLeft } : null,
    warnings,
    updatedAt: record.updatedAt.toISOString(),
  };
}

@Injectable()
export class TlsCertificatesService {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
    @Inject(TlsCertificateValidator) private readonly validator: TlsCertificateValidator,
    @Inject(TlsValidationGate) private readonly gate: TlsValidationGate,
    @Inject(SiteDomainsService) private readonly domainsService: SiteDomainsService,
  ) {}

  // ---------------------------------------------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------------------------------------------

  /** Every imported certificate of the organisation, oldest first. */
  public async list(organizationId: string): Promise<TlsCertificateDto[]> {
    const db = this.dbClient.db;
    const records = await listTlsCertificatesForOrganization(db, organizationId);
    return this.#dtos(db, organizationId, records);
  }

  public async get(organizationId: string, certificateId: string): Promise<TlsCertificateDto> {
    const db = this.dbClient.db;
    const record = await getTlsCertificate(db, organizationId, certificateId);
    if (!record) throw notFound();
    return (await this.#dtos(db, organizationId, [record]))[0]!;
  }

  async #dtos(
    ex: DatabaseExecutor,
    organizationId: string,
    records: readonly TlsCertificateRecord[],
  ): Promise<TlsCertificateDto[]> {
    if (records.length === 0) return [];
    const rows = await ex
      .select({
        id: domains.id,
        hostname: domains.hostname,
        siteId: domains.siteId,
        certMode: domains.certMode,
        manualVersionId: domains.manualCertificateVersionId,
      })
      .from(domains)
      .where(eq(domains.organizationId, organizationId));
    const siteRows = await ex.select({ id: sites.id, name: sites.name }).from(sites).where(eq(sites.organizationId, organizationId));
    const siteNames = new Map(siteRows.map((s) => [s.id, s.name]));
    const now = new Date();
    return records.map((record) => certificateDto(record, rows, siteNames, now));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Import and new versions (synchronous, 201, no operation)
  // ---------------------------------------------------------------------------------------------------------------

  /** Validates and stores a certificate with its version 1 (`pending`). A replay of the same request answers the same DTO. */
  public async importCertificate(input: {
    readonly scope: TlsScope;
    readonly actor: TlsActor;
    readonly idempotencyKey: string;
    readonly body: ImportTlsCertificateRequest;
    readonly audit: TlsAuditFn;
  }): Promise<TlsCertificateDto> {
    const { organizationId, siteId } = input.scope;
    const requestHash = canonicalRequestHash({ route: "tls.import", siteId, body: input.body });
    const replay = await this.#replayHolder(organizationId, input.idempotencyKey, requestHash);
    if (replay) return this.get(organizationId, replay.certificateId);

    await this.#assertCaps(this.dbClient.db, organizationId, input.actor, null);
    const material = await this.gate.run(organizationId, () => this.validator.validate(input.body));

    const stored = await this.#withOrganizationLock(organizationId, async (tx) => {
      await this.#assertCaps(tx, organizationId, input.actor, null);
      return insertTlsCertificateWithVersion(tx, {
        organizationId,
        name: input.body.name,
        createdForSiteId: siteId,
        createdByUserId: input.actor.userId,
        version: material,
        masterKey: this.config.secretsMasterKey,
        idempotencyKey: input.idempotencyKey,
        requestHash,
      });
    });
    if (!stored.replayed) {
      await input.audit({
        action: "site.tls_certificate.import",
        targetType: "tls_certificate",
        targetId: stored.certificateId,
        details: {
          certificateId: stored.certificateId,
          versionId: stored.versionId,
          fingerprintSha256: material.fingerprintSha256,
          siteId,
          notAfter: material.notAfter.toISOString(),
          wildcard: material.wildcard,
          sanCount: material.sanDns.length,
        },
      });
    }
    return this.get(organizationId, stored.certificateId);
  }

  /** Validates and stores the next version (`pending`) of an existing certificate. */
  public async addVersion(input: {
    readonly scope: TlsScope;
    readonly actor: TlsActor;
    readonly certificateId: string;
    readonly idempotencyKey: string;
    readonly body: CreateTlsCertificateVersionRequest;
    readonly audit: TlsAuditFn;
  }): Promise<TlsCertificateDto> {
    const { organizationId, siteId } = input.scope;
    const record = await getTlsCertificate(this.dbClient.db, organizationId, input.certificateId);
    if (!record) throw notFound();
    const requestHash = canonicalRequestHash({
      route: "tls.version",
      siteId,
      certificateId: input.certificateId,
      body: input.body,
    });
    const replay = await this.#replayHolder(organizationId, input.idempotencyKey, requestHash);
    if (replay) return this.get(organizationId, input.certificateId);

    await this.#assertCaps(this.dbClient.db, organizationId, input.actor, input.certificateId);
    const material = await this.gate.run(organizationId, () => this.validator.validate(input.body));

    const stored = await this.#withOrganizationLock(organizationId, async (tx) => {
      await this.#assertCaps(tx, organizationId, input.actor, input.certificateId);
      return insertTlsCertificateVersion(tx, {
        organizationId,
        certificateId: input.certificateId,
        createdByUserId: input.actor.userId,
        version: material,
        masterKey: this.config.secretsMasterKey,
        idempotencyKey: input.idempotencyKey,
        requestHash,
      });
    });
    if (!stored.replayed) {
      await input.audit({
        action: "site.tls_certificate.replace",
        targetType: "tls_certificate",
        targetId: input.certificateId,
        details: {
          certificateId: input.certificateId,
          versionId: stored.versionId,
          versionNumber: stored.versionNumber,
          previousVersionId: (currentVersion(record) ?? null)?.id ?? null,
          fingerprintSha256: material.fingerprintSha256,
          siteId,
          notAfter: material.notAfter.toISOString(),
          wildcard: material.wildcard,
          sanCount: material.sanDns.length,
        },
      });
    }
    return this.get(organizationId, input.certificateId);
  }

  /** The version holding the key for this organisation: a replay (same hash) or IDEMPOTENCY_CONFLICT. */
  async #replayHolder(
    organizationId: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<{ certificateId: string } | null> {
    const [holder] = await this.dbClient.db
      .select({ certificateId: tlsCertificateVersions.certificateId, requestHash: tlsCertificateVersions.requestHash })
      .from(tlsCertificateVersions)
      .where(and(eq(tlsCertificateVersions.organizationId, organizationId), eq(tlsCertificateVersions.idempotencyKey, idempotencyKey)))
      .limit(1);
    if (!holder) return null;
    if (holder.requestHash !== requestHash) {
      throw new ControlPlaneError("IDEMPOTENCY_CONFLICT", "The idempotency key was already used for a different request.");
    }
    return { certificateId: holder.certificateId };
  }

  /** Serialises imports of one organisation, so the caps cannot be raced. */
  async #withOrganizationLock<T>(organizationId: string, work: (tx: DatabaseClient["db"]) => Promise<T>): Promise<T> {
    try {
      return await this.dbClient.db.transaction(async (tx) => {
        await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, organizationId)).for("no key update");
        return work(tx as unknown as DatabaseClient["db"]);
      });
    } catch (err) {
      throw repositoryError(err);
    }
  }

  /**
   * `certificateId` null = a new certificate: 100 per organisation (everyone). A new version of an existing one: 20 per
   * certificate (everyone, QUOTA_EXCEEDED: a count, not a rate). Customers only: 10 imports or new versions per
   * organisation and hour, counted from the audit trail (so import + delete + import still counts) and from the
   * surviving version rows (an import whose audit row is not written yet), whichever is larger. Called under the
   * organisation lock for the answer that counts.
   */
  async #assertCaps(ex: DatabaseExecutor, organizationId: string, actor: TlsActor, certificateId: string | null): Promise<void> {
    if (certificateId === null) {
      const existing = await ex
        .select({ id: tlsCertificates.id })
        .from(tlsCertificates)
        .where(eq(tlsCertificates.organizationId, organizationId))
        .limit(TLS_CERTIFICATES_PER_ORGANIZATION);
      if (existing.length >= TLS_CERTIFICATES_PER_ORGANIZATION) {
        throw new ControlPlaneError("QUOTA_EXCEEDED", "This organization reached the limit of 100 imported certificates. Delete one first.");
      }
    } else {
      const versions = await ex
        .select({ id: tlsCertificateVersions.id })
        .from(tlsCertificateVersions)
        .where(and(eq(tlsCertificateVersions.organizationId, organizationId), eq(tlsCertificateVersions.certificateId, certificateId)))
        .limit(TLS_VERSIONS_PER_CERTIFICATE);
      if (versions.length >= TLS_VERSIONS_PER_CERTIFICATE) {
        throw new ControlPlaneError("QUOTA_EXCEEDED", "This certificate reached the limit of 20 versions. Import it as a new certificate instead.");
      }
    }
    if (!actor.capped) return;
    const now = Date.now();
    const since = new Date(now - HOUR_MS);
    const audited = await ex
      .select({ at: auditEvents.timestamp })
      .from(auditEvents)
      .leftJoin(users, eq(users.id, auditEvents.actorId))
      .where(
        and(
          eq(auditEvents.organizationId, organizationId),
          inArray(auditEvents.action, ["site.tls_certificate.import", "site.tls_certificate.replace"]),
          gt(auditEvents.timestamp, since),
          isNull(users.platformRole),
        ),
      )
      .orderBy(asc(auditEvents.timestamp));
    const rows = await ex
      .select({ at: tlsCertificateVersions.createdAt })
      .from(tlsCertificateVersions)
      .leftJoin(users, eq(users.id, tlsCertificateVersions.createdByUserId))
      .where(
        and(
          eq(tlsCertificateVersions.organizationId, organizationId),
          gt(tlsCertificateVersions.createdAt, since),
          isNull(users.platformRole),
        ),
      )
      .orderBy(asc(tlsCertificateVersions.createdAt));
    const recent = audited.length >= rows.length ? audited : rows;
    if (recent.length >= TLS_VERSIONS_PER_HOUR) {
      const freesAt = recent[recent.length - TLS_VERSIONS_PER_HOUR]!.at.getTime() + HOUR_MS;
      throw new ControlPlaneError("RATE_LIMITED", "Too many certificates were imported in the last hour. Try again later.", {
        retryable: true,
        retryAfterMs: Math.max(1_000, freesAt - now),
      });
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Assignment: domain <-> version (202, one site.tls.apply operation per request)
  // ---------------------------------------------------------------------------------------------------------------

  /** Moves one domain to an imported version, or back to ACME. */
  public async setDomainTls(input: {
    readonly scope: TlsScope;
    readonly actor: TlsActor;
    readonly domainId: string;
    readonly idempotencyKey: string;
    readonly body: SetDomainTlsRequest | AdminSetDomainTlsRequest;
    readonly audit: TlsAuditFn;
  }): Promise<TlsChangeResult> {
    const { body } = input;
    const change: TlsChange = { domainId: input.domainId, versionId: body.mode === "manual" ? body.versionId : null };
    const challenge = body.mode === "acme" ? (body as AdminSetDomainTlsRequest & { mode: "acme" }).challenge : undefined;
    const confirm = body.mode === "manual" && "evictAcme" in body && body.evictAcme === true ? { confirmHostname: body.confirmHostname! } : null;
    return this.#queue({
      ...input,
      changes: [change],
      requestHash: canonicalRequestHash({ route: "tls.domain", siteId: input.scope.siteId, domainId: input.domainId, body }),
      eviction: confirm,
      ...(challenge ? { challenge } : {}),
    });
  }

  /**
   * Serves `versionId` on the listed domains, or (absent `domainIds`) on every domain of the organisation that uses
   * another version of the same certificate (a rotation: all of them move together, or the equal-key overlap of the
   * old and the new version would be refused). With `authorizeSite` the domains may sit on any site of the
   * organisation: it is called for every other affected site (403 / 404 from the caller's permission check) before
   * anything is read or written. Without it the request stays on the requesting site, as before.
   */
  public async activateVersion(input: {
    readonly scope: TlsScope;
    readonly actor: TlsActor;
    readonly certificateId: string;
    readonly versionId: string;
    readonly idempotencyKey: string;
    readonly body: ActivateTlsVersionRequest | AdminActivateTlsVersionRequest;
    readonly audit: TlsAuditFn;
    readonly authorizeSite?: (siteId: string) => Promise<void>;
  }): Promise<TlsChangeResult> {
    const { organizationId, siteId } = input.scope;
    const db = this.dbClient.db;
    const [version] = await db
      .select({ id: tlsCertificateVersions.id })
      .from(tlsCertificateVersions)
      .where(
        and(
          eq(tlsCertificateVersions.id, input.versionId),
          eq(tlsCertificateVersions.certificateId, input.certificateId),
          eq(tlsCertificateVersions.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!version) throw notFound();

    const crossSite = input.authorizeSite !== undefined;
    let domainIds = input.body.domainIds;
    let affectedSites = new Set<string>();
    if (domainIds === undefined) {
      const sameCertificate = await db
        .select({ id: tlsCertificateVersions.id })
        .from(tlsCertificateVersions)
        .where(and(eq(tlsCertificateVersions.certificateId, input.certificateId), eq(tlsCertificateVersions.organizationId, organizationId)));
      const rows = await db
        .select({ id: domains.id, siteId: domains.siteId })
        .from(domains)
        .where(
          and(
            ...(crossSite ? [] : [eq(domains.siteId, siteId)]),
            eq(domains.organizationId, organizationId),
            eq(domains.certMode, "manual"),
            inArray(domains.manualCertificateVersionId, sameCertificate.map((v) => v.id)),
            not(eq(domains.manualCertificateVersionId, input.versionId)),
          ),
        )
        .orderBy(asc(domains.hostname));
      domainIds = rows.map((r) => r.id);
      affectedSites = new Set(rows.map((r) => r.siteId));
    } else if (crossSite && domainIds.length > 0) {
      const named = await db
        .select({ siteId: domains.siteId })
        .from(domains)
        .where(and(inArray(domains.id, domainIds), eq(domains.organizationId, organizationId)));
      affectedSites = new Set(named.map((r) => r.siteId));
    }
    // A site the caller cannot manage refuses the whole request; an id of another organisation is not in `named` and
    // is a 404 from the assignment check.
    for (const other of [...affectedSites].filter((id) => id !== siteId).sort()) await input.authorizeSite!(other);
    const eviction: Eviction | null =
      "evictAcme" in input.body && input.body.evictAcme === true ? { confirmHostname: input.body.confirmHostname! } : null;
    return this.#queue({
      ...input,
      crossSite,
      changes: domainIds.map((domainId) => ({ domainId, versionId: input.versionId })),
      requestHash: canonicalRequestHash({
        route: "tls.activate",
        siteId,
        certificateId: input.certificateId,
        versionId: input.versionId,
        body: input.body,
      }),
      eviction,
    });
  }

  async #queue(input: {
    readonly scope: TlsScope;
    readonly actor: TlsActor;
    readonly idempotencyKey: string;
    readonly changes: readonly TlsChange[];
    readonly requestHash: string;
    readonly eviction: Eviction | null;
    readonly challenge?: CertChallenge;
    readonly crossSite?: boolean;
    readonly audit: TlsAuditFn;
  }): Promise<TlsChangeResult> {
    const { organizationId, siteId } = input.scope;
    const current = async (queued: boolean, moved: TlsChangeResult["moved"] = []): Promise<TlsChangeResult> => ({
      data: await this.domainsService.list(siteId, organizationId),
      queued,
      moved,
    });

    // A key already used by this organisation: the same request is a replay (even once the operation settled and
    // the assignment reads as a no-op); another payload is a conflict.
    const [previous] = await this.dbClient.db
      .select({ requestHash: operations.requestHash })
      .from(operations)
      .where(and(eq(operations.organizationId, organizationId), eq(operations.idempotencyKey, input.idempotencyKey)))
      .limit(1);
    if (previous) {
      if (previous.requestHash !== input.requestHash) {
        throw new ControlPlaneError("IDEMPOTENCY_CONFLICT", "The idempotency key was already used for a different request.");
      }
      return current(false);
    }
    if (input.changes.length === 0) return current(false);

    const queued = await this.dbClient.db.transaction(async (tx) => {
      const plan = await checkAssignment(tx, {
        organizationId,
        siteId,
        changes: input.changes,
        ...(input.crossSite ? { crossSite: true } : {}),
        ...(input.eviction ? { evictAcme: true } : {}),
      });
      if (plan.noop) return null;
      if (input.eviction && !plan.domains.some((d) => d.hostname === input.eviction!.confirmHostname.toLowerCase())) {
        throw new ControlPlaneError("VALIDATION_ERROR", "The confirmation does not match the web address.", {
          details: [{ field: "confirmHostname", reason: "confirm_mismatch", message: "The confirmation does not match the web address." }],
        });
      }
      // The applier publishes the routes of every affected site: another site's own active operation must finish first.
      const otherSiteLocks = [...new Set(plan.domains.map((d) => d.siteId))].filter((id) => id !== siteId).map((id) => `site:${id}`);
      if (otherSiteLocks.length > 0) {
        const [busy] = await tx
          .select({ id: operations.id })
          .from(operations)
          .where(
            and(
              inArray(operations.lockKey, otherSiteLocks),
              sql`${operations.status} NOT IN (${sql.join(OPERATION_TERMINAL_STATUSES.map((st) => sql`${st}`), sql`, `)})`,
            ),
          )
          .limit(1);
        if (busy) throw new ControlPlaneError("RESOURCE_LOCKED", "Another change is in progress on a site this certificate change touches.");
      }
      const enqueued = await enqueueSiteTlsOperation(tx, {
        organizationId,
        siteId,
        changes: plan.changes,
        requestedByUserId: input.actor.userId,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        ...(input.eviction ? { evictAcme: true } : {}),
        ...(input.challenge ? { challenge: input.challenge } : {}),
      });
      return { plan, operationId: enqueued.operation.id, replay: enqueued.idempotentReplay };
    });
    if (queued === null || queued.replay) return current(false);

    const { plan, operationId } = queued;
    const eviction = input.eviction
      ? { evictAcme: true, evicted: plan.evictAcmeHosts, collateralHosts: plan.collateralHosts }
      : {};
    // One audit row per affected site and version: a request that spans sites is visible on each of them.
    const byVersion = (select: (d: (typeof plan.domains)[number]) => string | null, to: boolean) => {
      const groups = new Map<string, { siteId: string; versionId: string; domainIds: string[] }>();
      for (const d of plan.domains) {
        if ((d.versionId !== null) !== to) continue;
        const key = select(d);
        if (key === null) continue;
        const group = groups.get(`${d.siteId}|${key}`) ?? { siteId: d.siteId, versionId: key, domainIds: [] };
        group.domainIds.push(d.domainId);
        groups.set(`${d.siteId}|${key}`, group);
      }
      return [...groups.values()];
    };
    for (const { siteId: affected, versionId, domainIds } of byVersion((d) => d.versionId, true)) {
      await input.audit({
        action: "site.tls_certificate.assign",
        targetType: "site",
        targetId: affected,
        details: {
          operationId,
          siteId: affected,
          domainIds,
          versionId,
          fromVersionIds: [...new Set(plan.domains.filter((d) => domainIds.includes(d.domainId) && d.fromVersionId !== null).map((d) => d.fromVersionId!))],
          ...eviction,
        },
      });
    }
    for (const { siteId: affected, versionId, domainIds } of byVersion((d) => d.fromVersionId, false)) {
      await input.audit({
        action: "site.tls_certificate.unassign",
        targetType: "site",
        targetId: affected,
        details: { operationId, siteId: affected, domainIds, versionId, ...(input.challenge ? { challenge: input.challenge } : {}) },
      });
    }
    return current(true, plan.domains.map((d) => ({ domainId: d.domainId, siteId: d.siteId, hostname: d.hostname })));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------------------------------------------------------

  /** The organisation that owns a certificate (administrator routes without a site), or NOT_FOUND. */
  public async ownerOf(certificateId: string): Promise<string> {
    const [row] = await this.dbClient.db
      .select({ organizationId: tlsCertificates.organizationId })
      .from(tlsCertificates)
      .where(eq(tlsCertificates.id, certificateId))
      .limit(1);
    if (!row) throw notFound();
    return row.organizationId;
  }

  /**
   * Hard delete (204). Refused with CERTIFICATE_IN_USE while a domain uses a version, a version is applying or active,
   * or a non-terminal operation names one. The key ciphertext goes with the rows; the executor collects the files
   * after the next confirmed manifest (the desired generation is bumped here).
   */
  public async deleteCertificate(input: {
    readonly organizationId: string;
    readonly certificateId: string;
    readonly siteId?: string;
    readonly audit: TlsAuditFn;
  }): Promise<void> {
    const { organizationId, certificateId } = input;
    let removed: { versionIds: string[]; fingerprints: string[] };
    try {
      removed = await this.dbClient.db.transaction(async (tx) => {
        await lockTlsPublishState(tx);
        const record = await getTlsCertificate(tx, organizationId, certificateId);
        if (!record) throw notFound();
        if (record.versions.some((v) => v.status === "applying" || v.status === "active")) throw inUse();
        if (await this.#namedByOpenOperation(tx, organizationId, record.versions.map((v) => v.id))) throw inUse();
        const result = await deleteTlsCertificate(tx, { organizationId, certificateId });
        await bumpTlsDesiredGeneration(tx);
        return result;
      });
    } catch (err) {
      throw repositoryError(err);
    }
    await input.audit({
      action: "site.tls_certificate.delete",
      targetType: "tls_certificate",
      targetId: certificateId,
      details: {
        certificateId,
        versionIds: removed.versionIds,
        fingerprints: removed.fingerprints,
        ...(input.siteId ? { siteId: input.siteId } : {}),
      },
    });
  }

  /** Does a non-terminal site.tls.apply operation of the organisation carry one of these versions in its payload? */
  async #namedByOpenOperation(ex: DatabaseExecutor, organizationId: string, versionIds: readonly string[]): Promise<boolean> {
    const open = await ex
      .select({ id: operations.id, status: operations.status })
      .from(operations)
      .where(and(eq(operations.organizationId, organizationId), eq(operations.kind, "site.tls.apply")));
    const openIds = open.filter((o) => !(OPERATION_TERMINAL_STATUSES as readonly string[]).includes(o.status)).map((o) => o.id);
    if (openIds.length === 0) return false;
    const events = await ex
      .select({ payload: outboxEvents.payload })
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.eventType, "operation.queued.site.tls.apply"),
          sql`${outboxEvents.payload}->>'organizationId' = ${organizationId}`,
        ),
      );
    const text = JSON.stringify(
      events.map((e) => e.payload as { operationId?: string }).filter((p) => p.operationId !== undefined && openIds.includes(p.operationId)),
    );
    return versionIds.some((id) => text.includes(id));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Administrator: inventory and alerts
  // ---------------------------------------------------------------------------------------------------------------

  /** Imported certificates and the automatic (ACME) ones of every organisation, by end date (soonest first). */
  public async adminInventory(query: AdminTlsInventoryQuery, now: Date = new Date()): Promise<AdminTlsInventoryItemDto[]> {
    const db = this.dbClient.db;
    const items: AdminTlsInventoryItemDto[] = [];

    if (query.filter !== "automatic") {
      const certificates = await db
        .select({
          id: tlsCertificates.id,
          name: tlsCertificates.name,
          activeVersionId: tlsCertificates.activeVersionId,
          organizationId: tlsCertificates.organizationId,
          organizationName: organizations.name,
          siteId: tlsCertificates.createdForSiteId,
        })
        .from(tlsCertificates)
        .innerJoin(organizations, eq(organizations.id, tlsCertificates.organizationId));
      const versions = certificates.length
        ? await db
            .select({
              id: tlsCertificateVersions.id,
              certificateId: tlsCertificateVersions.certificateId,
              versionNumber: tlsCertificateVersions.versionNumber,
              issuer: tlsCertificateVersions.issuer,
              sanDns: tlsCertificateVersions.sanDns,
              notAfter: tlsCertificateVersions.notAfter,
              status: tlsCertificateVersions.status,
            })
            .from(tlsCertificateVersions)
            .orderBy(asc(tlsCertificateVersions.certificateId), asc(tlsCertificateVersions.versionNumber))
        : [];
      const siteIds = [...new Set(certificates.flatMap((c) => (c.siteId ? [c.siteId] : [])))];
      const siteRows = siteIds.length ? await db.select({ id: sites.id, name: sites.name }).from(sites).where(inArray(sites.id, siteIds)) : [];
      const siteNames = new Map(siteRows.map((s) => [s.id, s.name]));
      for (const c of certificates) {
        const own = versions.filter((v) => v.certificateId === c.id);
        const v = own.find((x) => x.id === c.activeVersionId) ?? own[own.length - 1];
        if (!v) continue;
        items.push({
          source: "manual",
          certificateId: c.id,
          name: c.name,
          organizationId: c.organizationId,
          organizationName: c.organizationName,
          siteId: c.siteId,
          siteName: c.siteId ? (siteNames.get(c.siteId) ?? null) : null,
          hostnames: v.sanDns,
          issuer: v.issuer,
          wildcard: wildcardOf(v.sanDns),
          notAfter: v.notAfter.toISOString(),
          status: v.status,
          tier: certificateExpiryTier(v.notAfter, now).tier,
        });
      }
    }

    if (query.filter !== "manual") {
      const rows = await db
        .select({
          hostname: domains.hostname,
          certStatus: domains.certStatus,
          certExpiresAt: domains.certExpiresAt,
          organizationId: domains.organizationId,
          organizationName: organizations.name,
          siteId: sites.id,
          siteName: sites.name,
        })
        .from(domains)
        .innerJoin(organizations, eq(organizations.id, domains.organizationId))
        .innerJoin(sites, eq(sites.id, domains.siteId))
        .where(and(eq(domains.certMode, "acme"), inArray(domains.certStatus, ["requested", "active", "failed"])));
      for (const r of rows) {
        items.push({
          source: "acme",
          certificateId: null,
          name: null,
          organizationId: r.organizationId,
          organizationName: r.organizationName,
          siteId: r.siteId,
          siteName: r.siteName,
          hostnames: [r.hostname],
          issuer: null,
          wildcard: false,
          notAfter: iso(r.certExpiresAt),
          status: r.certStatus as AdminTlsInventoryItemDto["status"],
          tier: r.certExpiresAt ? certificateExpiryTier(r.certExpiresAt, now).tier : null,
        });
      }
    }

    const needle = query.q?.toLowerCase() ?? "";
    return items
      .filter((item) => {
        if (query.filter === "expiring" && !(item.tier === "notice" || item.tier === "warning" || item.tier === "critical")) return false;
        if (query.filter === "expired" && item.tier !== "expired") return false;
        return (
          needle === "" ||
          item.hostnames.some((h) => h.toLowerCase().includes(needle)) ||
          (item.issuer ?? "").toLowerCase().includes(needle)
        );
      })
      .sort(
        (a, b) =>
          (a.notAfter ?? "￿").localeCompare(b.notAfter ?? "￿") || (a.hostnames[0] ?? "").localeCompare(b.hostnames[0] ?? ""),
      );
  }

  /** One alert per active imported version at tier warning, critical or expired. */
  public alerts(now: Date = new Date()): Promise<TlsCertificateAlertDto[]> {
    return manualExpiryAlerts(this.dbClient.db, now);
  }
}
