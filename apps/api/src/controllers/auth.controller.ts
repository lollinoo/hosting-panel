import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
} from "@nestjs/common";
import { LoginInputSchema, type DevPersonaDto, type LoginResultDto } from "@hosting-panel/contracts";
import { eq, users, type DatabaseClient } from "@hosting-panel/database";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { AuthzContextService } from "../auth/authz-context.service.js";
import { LoginService } from "../auth/login.service.js";
import { OidcService } from "../auth/oidc.service.js";
import { ControlPlaneError, extractClientIp } from "../common/control-plane.error.js";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  DATABASE_CLIENT_TOKEN,
  type ControlPlaneRuntimeConfig,
} from "../tokens.js";

const SEEDED_PERSONAS: readonly DevPersonaDto[] = Object.freeze([
  {
    id: "usr_infra",
    email: "infra@hcp.local",
    name: "Admin Infrastruttura",
    description: "Amministratore infrastrutturale host Linux e Docker Engine (HCP-SPEC-002 §4.1)",
    role: "infrastructure_admin",
    organizationId: null,
    globalRoles: ["infrastructure_admin"],
  },
  {
    id: "usr_hosting",
    email: "hosting@hcp.local",
    name: "Admin Hosting",
    description: "Amministratore del servizio hosting e template (HCP-SPEC-002 §4.1)",
    role: "hosting_admin",
    organizationId: null,
    globalRoles: ["hosting_admin"],
  },
  {
    id: "usr_elena",
    email: "elena@acme.it",
    name: "Elena Rossi (Acme Owner)",
    description: "Customer Owner di Acme S.r.l. (HCP-SPEC-002 §4.1)",
    role: "customer_owner",
    organizationId: "org_acme",
    globalRoles: [],
  },
  {
    id: "usr_marco",
    email: "marco@acme.it",
    name: "Marco Bianchi (Acme Dev)",
    description: "Customer Collaborator con permessi granulari ABAC (HCP-SPEC-002 §4.1)",
    role: "customer_collaborator",
    organizationId: "org_acme",
    globalRoles: [],
  },
  {
    id: "usr_giulia",
    email: "giulia@gamma.it",
    name: "Giulia Verdi (Gamma Suspended)",
    description: "Customer Owner di Gamma Archivio S.r.l. - organizzazione sospesa (HCP-SPEC-002 §4.1)",
    role: "customer_owner",
    organizationId: "org_gamma",
    globalRoles: [],
  },
]);

const IssueTokenBodySchema = z.object({
  userId: z.string().min(1).optional(),
  email: z.string().email().optional(),
  expiresInSeconds: z.number().int().positive().optional(),
});

@Controller()
export class AuthController {
  public constructor(
    @Inject(CONTROL_PLANE_CONFIG_TOKEN)
    private readonly config: ControlPlaneRuntimeConfig,
    @Inject(DATABASE_CLIENT_TOKEN)
    private readonly dbClient: DatabaseClient,
    @Inject(OidcService)
    private readonly oidcService: OidcService,
    @Inject(AuthzContextService)
    private readonly authzService: AuthzContextService,
    @Inject(LoginService)
    private readonly loginService: LoginService,
  ) {}

  @Post("v1/auth/login")
  @HttpCode(HttpStatus.OK)
  public async login(@Req() req: FastifyRequest, @Body() rawBody: unknown): Promise<{ data: LoginResultDto }> {
    const input = LoginInputSchema.parse(rawBody ?? {});
    return { data: await this.loginService.login(input, extractClientIp(req)) };
  }

  @Get("v1/dev/auth/personas")
  public getPersonas(): { data: readonly DevPersonaDto[] } {
    if (!this.config.enableDevOidc) {
      throw new ControlPlaneError("NOT_FOUND", "Dev OIDC personas endpoint is disabled.");
    }
    return { data: SEEDED_PERSONAS };
  }

  @Post("v1/dev/auth/token")
  @HttpCode(HttpStatus.OK)
  public async issueDevToken(@Body() rawBody: unknown): Promise<{
    data: {
      accessToken: string;
      tokenType: "Bearer";
      expiresIn: number;
      expiresAt: string;
      issuer: string;
      audience: string;
      user: {
        id: string;
        email: string;
        name: string;
      };
    };
  }> {
    if (!this.config.enableDevOidc) {
      throw new ControlPlaneError("NOT_FOUND", "Dev OIDC token endpoint is disabled.");
    }

    const body = IssueTokenBodySchema.parse(rawBody ?? {});

    let targetUserId = body.userId;
    const targetEmail = body.email;

    if (!targetUserId && !targetEmail) {
      targetUserId = "usr_infra";
    }

    let user;
    if (targetUserId) {
      const [u] = await this.dbClient.db
        .select()
        .from(users)
        .where(eq(users.id, targetUserId))
        .limit(1);
      user = u;
    } else if (targetEmail) {
      const [u] = await this.dbClient.db
        .select()
        .from(users)
        .where(eq(users.email, targetEmail))
        .limit(1);
      user = u;
    }

    if (!user) {
      throw new ControlPlaneError("NOT_FOUND", "Requested persona or user was not found.");
    }

    const tokenResult = await this.oidcService.issueToken({
      subject: user.id,
      email: user.email,
      displayName: user.name,
      expiresInSeconds: body.expiresInSeconds,
    });

    return {
      data: {
        accessToken: tokenResult.accessToken,
        tokenType: "Bearer",
        expiresIn: tokenResult.expiresIn,
        expiresAt: tokenResult.expiresAt,
        issuer: tokenResult.issuer,
        audience: tokenResult.audience,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
        },
      },
    };
  }

  @Post("v1/auth/revoke")
  @HttpCode(HttpStatus.OK)
  public async revokeToken(
    @Req() req: FastifyRequest,
  ): Promise<{ data: { revoked: boolean; revokedAt: string } }> {
    const auth = await this.authzService.authenticateRequest(req);
    const jti = auth.claims.jti;

    await this.oidcService.revokeSession(jti);

    await this.authzService.recordAudit(auth, req, {
      action: "auth.token.revoke",
      targetType: "jwt",
      targetId: jti,
      details: { jti },
    });

    return {
      data: {
        revoked: true,
        revokedAt: new Date().toISOString(),
      },
    };
  }
}
