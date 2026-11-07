import { randomUUID } from "node:crypto";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { evaluatePolicy } from "@hosting-panel/authz";
import {
  AsyncAcceptedEnvelopeSchema,
  CertificateObservationDtoSchema,
  DomainDtoSchema,
  type AsyncAcceptedEnvelope,
  type CertificateObservationDto,
  type DomainDto,
  type PaginatedListEnvelope,
  type SingleReadEnvelope,
} from "@hosting-panel/contracts";
import {
  and,
  appendAuditEvent,
  asc,
  certificateObservations,
  domains,
  enqueueOperationTransactional,
  eq,
  hostingResources,
  inArray,
  mapOperationToDto,
  quotaAllocations,
  sql,
  type CertificateObservationRow,
  type DatabaseClient,
} from "@hosting-panel/database";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { AuthzContextService } from "../auth/authz-context.service.js";
import {
  ControlPlaneError,
  extractClientIp,
  paginateItems,
  parsePaginationQuery,
  resolveOptionalIdempotencyKey,
  resolveRequestId,
} from "../common/control-plane.error.js";
import { EventsBusService } from "../operations/events-bus.service.js";
import { DATABASE_CLIENT_TOKEN } from "../tokens.js";

function generatePrefixedId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

const CreateDomainInputSchema = z.strictObject({
  applicationId: z.string().trim().min(1).max(128),
  hostname: z.string().trim().min(1).max(255),
  isPrimary: z.boolean().optional(),
  httpsEnabled: z.boolean().optional(),
});

const CANONICAL_FQDN_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function canonicalizeFqdn(rawHostname: string): string {
  const cleaned = rawHostname.trim().toLowerCase().replace(/\.$/, "");
  if (!CANONICAL_FQDN_PATTERN.test(cleaned)) {
    throw new ControlPlaneError(
      "VALIDATION_ERROR",
      "Domain hostname must be a valid fully-qualified domain name (FQDN).",
      {
        details: [
          {
            field: "hostname",
            message: "Must be a valid DNS hostname such as 'app.esempio.it'.",
            reason: "INVALID_FQDN",
          },
        ],
      },
    );
  }
  return cleaned;
}

function mapCertificateDto(row: CertificateObservationRow): CertificateObservationDto {
  return CertificateObservationDtoSchema.parse({
    id: row.id,
    domainId: row.domainId,
    organizationId: row.organizationId,
    hostname: row.hostname,
    status: row.status,
    issuer: row.issuer,
    validFrom: row.validFrom ? row.validFrom.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    observedAt: row.observedAt ? row.observedAt.toISOString() : null,
    source: row.source,
  });
}

@Controller("v1/organizations/:orgId")
export class DomainsController {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(AuthzContextService) private readonly authzContext: AuthzContextService,
    @Inject(EventsBusService) private readonly eventsBus: EventsBusService,
  ) {}

  @Get("domains")
  public async listDomains(
    @Param("orgId") orgId: string,
    @Query() query: Record<string, unknown>,
    @Req() req: FastifyRequest,
  ): Promise<PaginatedListEnvelope<DomainDto>> {
    const auth = await this.authzContext.authenticateRequest(req);
    await this.authzContext.requireOrgListPermission(
      auth,
      req,
      orgId,
      "domain.read",
      "domain",
    );

    const pagination = parsePaginationQuery(query);
    const db = this.dbClient.db;

    const domainRows = await db
      .select()
      .from(domains)
      .where(eq(domains.organizationId, orgId))
      .orderBy(asc(domains.hostname), asc(domains.id));

    const now = new Date();
    const authorizedDomains = domainRows.filter(
      (d) =>
        evaluatePolicy({
          principal: auth.principal,
          permission: "domain.read",
          organizationId: orgId,
          resource: { id: d.applicationResourceId, organizationId: d.organizationId },
          now,
        }).allowed,
    );

    const domainIds = authorizedDomains.map((d) => d.id);
    const certRows =
      domainIds.length > 0
        ? await db
            .select()
            .from(certificateObservations)
            .where(
              and(
                eq(certificateObservations.organizationId, orgId),
                inArray(certificateObservations.domainId, domainIds),
              ),
            )
        : [];

    const certByDomainId = new Map<string, CertificateObservationRow>();
    for (const cert of certRows) {
      certByDomainId.set(cert.domainId, cert);
    }

    const items = authorizedDomains.map((d) => {
      const cert = certByDomainId.get(d.id);
      return DomainDtoSchema.parse({
        id: d.id,
        organizationId: d.organizationId,
        applicationId: d.applicationResourceId,
        hostname: d.hostname,
        isPrimary: d.isPrimary,
        verificationStatus: d.verificationStatus,
        httpsEnabled: d.httpsEnabled,
        certificate: cert ? mapCertificateDto(cert) : null,
        createdAt: d.createdAt.toISOString(),
        updatedAt: d.updatedAt.toISOString(),
      });
    });

    const paged = paginateItems(items, pagination);
    return {
      data: paged.data,
      page: paged.page,
    };
  }

  @Post("domains")
  @HttpCode(201)
  public async createDomain(
    @Param("orgId") orgId: string,
    @Body() rawBody: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SingleReadEnvelope<DomainDto>> {
    const auth = await this.authzContext.authenticateRequest(req);
    await this.authzContext.requireTenantBoundary(
      auth,
      req,
      orgId,
      "domain.manage",
      "domain",
      null,
    );

    const input = CreateDomainInputSchema.parse(rawBody ?? {});
    const canonicalHostname = canonicalizeFqdn(input.hostname);
    const db = this.dbClient.db;
    const requestId = resolveRequestId(req);

    // Ensure application belongs to orgId BEFORE checking domain.manage or global hostname conflict
    const [appResource] = await db
      .select()
      .from(hostingResources)
      .where(
        and(
          eq(hostingResources.id, input.applicationId),
          eq(hostingResources.organizationId, orgId),
          eq(hostingResources.type, "application"),
        ),
      )
      .limit(1);

    if (!appResource) {
      throw new ControlPlaneError(
        "NOT_FOUND",
        "Target application was not found in organization.",
      );
    }

    await this.authzContext.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission: "domain.manage",
      targetType: "domain",
      resource: { id: appResource.id, organizationId: appResource.organizationId },
    });

    const createdDto = await db.transaction(async (tx) => {
      // AC-014: Global cross-organization FQDN conflict check (never reveal foreign org identity!)
      const [existingDomain] = await tx
        .select({ id: domains.id })
        .from(domains)
        .where(eq(domains.hostname, canonicalHostname))
        .limit(1);

      if (existingDomain) {
        await appendAuditEvent(tx, {
          organizationId: orgId,
          actorUserId: auth.user.id,
          actorEmail: auth.user.email,
          action: "domain.create",
          targetType: "domain",
          targetId: null,
          outcome: "denied",
          requestId,
          ipAddress: extractClientIp(req),
          metadata: {
            hostname: canonicalHostname,
            reason: "DOMAIN_CONFLICT",
          },
        });
        throw new ControlPlaneError(
          "DOMAIN_CONFLICT",
          `Domain '${canonicalHostname}' is already registered and cannot be claimed.`,
        );
      }

      const [quota] = await tx
        .select()
        .from(quotaAllocations)
        .where(eq(quotaAllocations.organizationId, orgId))
        .for("update");

      if (quota && quota.domainsUsed >= quota.domainsLimit) {
        throw new ControlPlaneError(
          "PLAN_LIMIT",
          "Organization domain quota limit has been reached.",
        );
      }

      const now = new Date();
      const domainId = generatePrefixedId("dom");
      const certId = generatePrefixedId("cert");

      const [insertedDomain] = await tx
        .insert(domains)
        .values({
          id: domainId,
          organizationId: orgId,
          applicationResourceId: appResource.id,
          hostname: canonicalHostname,
          isPrimary: input.isPrimary ?? false,
          verificationStatus: "pending",
          httpsEnabled: input.httpsEnabled ?? true,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      if (!insertedDomain) {
        throw new ControlPlaneError("INTERNAL_ERROR", "Failed to persist domain record.");
      }

      const [insertedCert] = await tx
        .insert(certificateObservations)
        .values({
          id: certId,
          domainId,
          organizationId: orgId,
          hostname: canonicalHostname,
          status: "unknown",
          issuer: null,
          validFrom: null,
          expiresAt: null,
          observedAt: now,
          source: "coolify",
        })
        .returning();

      if (quota) {
        await tx
          .update(quotaAllocations)
          .set({
            domainsUsed: sql`${quotaAllocations.domainsUsed} + 1`,
            updatedAt: now,
          })
          .where(eq(quotaAllocations.id, quota.id));
      }

      await appendAuditEvent(tx, {
        organizationId: orgId,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: "domain.create",
        targetType: "domain",
        targetId: domainId,
        outcome: "succeeded",
        requestId,
        ipAddress: extractClientIp(req),
        metadata: {
          hostname: canonicalHostname,
          applicationId: appResource.id,
        },
        occurredAt: now,
      });

      return DomainDtoSchema.parse({
        id: insertedDomain.id,
        organizationId: insertedDomain.organizationId,
        applicationId: insertedDomain.applicationResourceId,
        hostname: insertedDomain.hostname,
        isPrimary: insertedDomain.isPrimary,
        verificationStatus: insertedDomain.verificationStatus,
        httpsEnabled: insertedDomain.httpsEnabled,
        certificate: insertedCert ? mapCertificateDto(insertedCert) : null,
        createdAt: insertedDomain.createdAt.toISOString(),
        updatedAt: insertedDomain.updatedAt.toISOString(),
      });
    });

    return { data: createdDto };
  }

  @Post("domains/:domainId/recheck")
  @HttpCode(202)
  public async recheckDomain(
    @Param("orgId") orgId: string,
    @Param("domainId") domainId: string,
    @Req() req: FastifyRequest,
  ): Promise<AsyncAcceptedEnvelope> {
    const auth = await this.authzContext.authenticateRequest(req);
    await this.authzContext.requireTenantBoundary(
      auth,
      req,
      orgId,
      "certificate.recheck",
      "domain",
      domainId,
    );

    const [domainRow] = await this.dbClient.db
      .select()
      .from(domains)
      .where(and(eq(domains.id, domainId), eq(domains.organizationId, orgId)))
      .limit(1);

    if (!domainRow) {
      throw new ControlPlaneError("NOT_FOUND", "Domain was not found.");
    }

    await this.authzContext.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission: "certificate.recheck",
      targetType: "domain",
      targetId: domainRow.id,
      resource: {
        id: domainRow.applicationResourceId,
        organizationId: domainRow.organizationId,
      },
    });

    const idempotencyKey = resolveOptionalIdempotencyKey(
      req.headers as Record<string, string | string[] | undefined>,
      "idem_domain_recheck",
    );
    const requestId = resolveRequestId(req);

    const result = await enqueueOperationTransactional(this.dbClient.db, {
      organizationId: orgId,
      resourceType: "domain",
      resourceId: domainRow.id,
      kind: "domain.recheck",
      requestedByUserId: auth.user.id,
      actorEmail: auth.user.email,
      idempotencyKey,
      payload: { domainId: domainRow.id },
      requestId,
      ipAddress: extractClientIp(req),
    });

    if (!result.ok) {
      throw new ControlPlaneError(result.errorCode, result.message);
    }

    if (!result.deduplicated) {
      this.eventsBus.publishOperationUpdated(mapOperationToDto(result.operation));
    }

    return AsyncAcceptedEnvelopeSchema.parse({
      data: {
        operationId: result.operation.id,
        status: result.operation.status,
        resourceId: domainRow.id,
        submittedAt: result.operation.submittedAt.toISOString(),
      },
      links: {
        self: `/v1/organizations/${orgId}/operations/${result.operation.id}`,
      },
    });
  }

  @Get("certificates")
  public async listCertificates(
    @Param("orgId") orgId: string,
    @Query() query: Record<string, unknown>,
    @Req() req: FastifyRequest,
  ): Promise<PaginatedListEnvelope<CertificateObservationDto>> {
    const auth = await this.authzContext.authenticateRequest(req);
    await this.authzContext.requireOrgListPermission(
      auth,
      req,
      orgId,
      "certificate.read",
      "certificate",
    );

    const pagination = parsePaginationQuery(query);
    const rows = await this.dbClient.db
      .select({
        cert: certificateObservations,
        domain: domains,
      })
      .from(certificateObservations)
      .innerJoin(domains, eq(certificateObservations.domainId, domains.id))
      .where(eq(certificateObservations.organizationId, orgId))
      .orderBy(asc(certificateObservations.hostname), asc(certificateObservations.id));

    const now = new Date();
    const authorized = rows.filter(
      (r) =>
        evaluatePolicy({
          principal: auth.principal,
          permission: "certificate.read",
          organizationId: orgId,
          resource: {
            id: r.domain.applicationResourceId,
            organizationId: r.domain.organizationId,
          },
          now,
        }).allowed,
    );

    const items = authorized.map((r) => mapCertificateDto(r.cert));
    const paged = paginateItems(items, pagination);

    return {
      data: paged.data,
      page: paged.page,
    };
  }
}
