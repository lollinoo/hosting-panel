import { Controller, Get, Inject, Query, Req } from "@nestjs/common";
import { resolveEffectiveOrgPermissions } from "@hosting-panel/authz";
import {
  MeDtoSchema,
  OrganizationSummaryDtoSchema,
  type MeDto,
  type OrganizationSummaryDto,
  type PaginatedListEnvelope,
  type SingleReadEnvelope,
} from "@hosting-panel/contracts";
import type { FastifyRequest } from "fastify";
import { AuthzContextService } from "../auth/authz-context.service.js";
import {
  paginateItems,
  parsePaginationQuery,
} from "../common/control-plane.error.js";

@Controller("v1/me")
export class MeController {
  public constructor(
    @Inject(AuthzContextService) private readonly authzContext: AuthzContextService,
  ) {}

  @Get()
  public async getMe(@Req() req: FastifyRequest): Promise<SingleReadEnvelope<MeDto>> {
    const auth = await this.authzContext.authenticateRequest(req);
    const now = new Date();
    const nowMs = now.getTime();

    const activeSupportGrant =
      (auth.principal.supportGrants ?? []).find(
        (g) => Date.parse(g.expiresAt) > nowMs,
      ) ?? null;

    const dto = MeDtoSchema.parse({
      user: {
        id: auth.user.id,
        email: auth.user.email,
        displayName: auth.user.displayName,
        isPlatformAdmin: auth.user.isPlatformAdmin,
      },
      memberships: auth.activeMembershipSummaries.map((item) => ({
        organizationId: item.organization.id,
        organizationSlug: item.organization.slug,
        organizationName: item.organization.name,
        organizationType: item.organization.type,
        organizationStatus: item.organization.status,
        roles: [...item.roleNames],
        permissions: resolveEffectiveOrgPermissions(
          auth.principal,
          item.organization.id,
          now,
        ),
      })),
      impersonation: {
        active: activeSupportGrant !== null,
        sessionId: activeSupportGrant?.id ?? null,
        targetOrganizationId: activeSupportGrant?.organizationId ?? null,
        expiresAt: activeSupportGrant?.expiresAt ?? null,
      },
    });

    return { data: dto };
  }

  @Get("organizations")
  public async getMyOrganizations(
    @Req() req: FastifyRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<PaginatedListEnvelope<OrganizationSummaryDto>> {
    const auth = await this.authzContext.authenticateRequest(req);
    const pagination = parsePaginationQuery(query);

    const items = auth.activeMembershipSummaries.map((item) =>
      OrganizationSummaryDtoSchema.parse({
        id: item.organization.id,
        slug: item.organization.slug,
        name: item.organization.name,
        type: item.organization.type,
        status: item.organization.status,
        createdAt: item.organization.createdAt.toISOString(),
      }),
    );

    const paged = paginateItems(items, pagination);
    return {
      data: paged.data,
      page: paged.page,
    };
  }
}
