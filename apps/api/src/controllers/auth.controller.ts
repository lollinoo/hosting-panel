import { Body, Controller, Get, HttpCode, Inject, Post, Req } from "@nestjs/common";
import {
  and,
  appendAuditEvent,
  asc,
  eq,
  membershipRoles,
  memberships,
  organizations,
  roles,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { AuthzContextService } from "../auth/authz-context.service.js";
import { OidcService } from "../auth/oidc.service.js";
import {
  ControlPlaneError,
  extractClientIp,
  resolveRequestId,
} from "../common/control-plane.error.js";
import { DATABASE_CLIENT_TOKEN } from "../tokens.js";

export const DevIssueTokenInputSchema = z
  .strictObject({
    userId: z.string().trim().min(1).max(128).optional(),
    email: z.email().optional(),
    expiresInSeconds: z.number().int().min(1).max(86_400).optional(),
  })
  .refine((val) => Boolean(val.userId || val.email), {
    message: "Either 'userId' or 'email' must be provided.",
  });

export interface DevPersonaOrganizationSummary {
  readonly organizationId: string;
  readonly organizationSlug: string;
  readonly organizationName: string;
  readonly organizationStatus: string;
  readonly roles: readonly string[];
}

export interface DevPersonaDto {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly isPlatformAdmin: boolean;
  readonly organizations: readonly DevPersonaOrganizationSummary[];
}

@Controller("v1")
export class AuthController {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(OidcService) private readonly oidcService: OidcService,
    @Inject(AuthzContextService) private readonly authzContext: AuthzContextService,
  ) {}

  @Post("auth/revoke")
  @HttpCode(200)
  public async revokeCurrentToken(@Req() req: FastifyRequest): Promise<{
    readonly data: {
      readonly revoked: true;
      readonly revokedAt: string;
    };
  }> {
    const auth = await this.authzContext.authenticateRequest(req);
    this.oidcService.revokeTokenJti(auth.claims.jti, auth.claims.exp);

    const now = new Date();
    await appendAuditEvent(this.dbClient.db, {
      organizationId: null,
      actorUserId: auth.user.id,
      actorEmail: auth.user.email,
      action: "auth.session.revoke",
      targetType: "session",
      targetId: auth.claims.jti,
      outcome: "succeeded",
      requestId: resolveRequestId(req),
      ipAddress: extractClientIp(req),
      metadata: {
        revoked: true,
      },
      occurredAt: now,
    });

    return {
      data: {
        revoked: true,
        revokedAt: now.toISOString(),
      },
    };
  }

  @Get("dev/auth/personas")
  public async listDevPersonas(): Promise<{
    readonly data: readonly DevPersonaDto[];
  }> {
    this.#assertDevOidcEnabled();
    const db = this.dbClient.db;

    const activeUsers = await db
      .select()
      .from(users)
      .where(eq(users.status, "active"))
      .orderBy(asc(users.id));

    const allMemberships = await db
      .select({
        membership: memberships,
        organization: organizations,
      })
      .from(memberships)
      .innerJoin(organizations, eq(memberships.organizationId, organizations.id))
      .where(eq(memberships.status, "active"));

    const allRoleRows = await db
      .select({
        membershipRole: membershipRoles,
        role: roles,
      })
      .from(membershipRoles)
      .innerJoin(roles, eq(membershipRoles.roleId, roles.id));

    const personas: DevPersonaDto[] = activeUsers.map((user) => {
      const userMbrs = allMemberships.filter((m) => m.membership.userId === user.id);
      const orgSummaries: DevPersonaOrganizationSummary[] = userMbrs.map((m) => {
        const roleNames = [
          ...new Set(
            allRoleRows
              .filter((r) => r.membershipRole.membershipId === m.membership.id)
              .map((r) => r.role.name),
          ),
        ];
        return {
          organizationId: m.organization.id,
          organizationSlug: m.organization.slug,
          organizationName: m.organization.name,
          organizationStatus: m.organization.status,
          roles: roleNames,
        };
      });

      return {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        isPlatformAdmin: user.isPlatformAdmin,
        organizations: orgSummaries,
      };
    });

    return { data: personas };
  }

  @Post("dev/auth/token")
  @HttpCode(200)
  public async issueDevToken(@Body() rawBody: unknown): Promise<{
    readonly data: {
      readonly accessToken: string;
      readonly tokenType: "Bearer";
      readonly expiresIn: number;
      readonly expiresAt: string;
      readonly issuer: string;
      readonly audience: string;
      readonly user: {
        readonly id: string;
        readonly email: string;
        readonly displayName: string;
        readonly isPlatformAdmin: boolean;
      };
    };
  }> {
    this.#assertDevOidcEnabled();
    const input = DevIssueTokenInputSchema.parse(rawBody ?? {});
    const db = this.dbClient.db;

    const whereClause = input.userId
      ? and(eq(users.id, input.userId), eq(users.status, "active"))
      : and(eq(users.email, (input.email ?? "").trim().toLowerCase()), eq(users.status, "active"));

    const [user] = await db.select().from(users).where(whereClause).limit(1);
    if (!user) {
      throw new ControlPlaneError("NOT_FOUND", "Requested demo persona was not found.");
    }

    const issued = await this.oidcService.issueToken({
      subject: user.subject,
      email: user.email,
      displayName: user.displayName,
      expiresInSeconds: input.expiresInSeconds,
    });

    return {
      data: {
        accessToken: issued.accessToken,
        tokenType: "Bearer",
        expiresIn: issued.expiresIn,
        expiresAt: issued.expiresAt,
        issuer: issued.issuer,
        audience: issued.audience,
        user: {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          isPlatformAdmin: user.isPlatformAdmin,
        },
      },
    };
  }

  #assertDevOidcEnabled(): void {
    if (!this.oidcService.isDevOidcEnabled()) {
      throw new ControlPlaneError(
        "NOT_FOUND",
        "Requested endpoint was not found.",
      );
    }
  }
}
