import { randomUUID } from "node:crypto";
import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Req } from "@nestjs/common";
import {
  CreateCustomerAccountInputSchema,
  type AdminUserDto,
  type ErrorCode,
} from "@hosting-panel/contracts";
import {
  allocateHostTransactional,
  asc,
  eq,
  hosts,
  membershipRoles,
  memberships,
  organizations,
  users,
  type DatabaseClient,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { AuthzContextService } from "../auth/authz-context.service.js";
import { OidcService } from "../auth/oidc.service.js";
import { requireServerAdmin } from "../auth/server-admin.guard.js";
import { generateTemporaryPassword, hashPassword } from "../auth/password.js";
import { resetUserPassword, resetUserTotp } from "../cli/accounts.js";
import { ControlPlaneError } from "../common/control-plane.error.js";
import { CONTROL_PLANE_CONFIG_TOKEN, DATABASE_CLIENT_TOKEN, type ControlPlaneRuntimeConfig } from "../tokens.js";

const CUSTOMER_OWNER_ROLE_ID = "role_customer_owner";
const StatusBody = z.object({ status: z.enum(["active", "disabled"]) });

const toDto = (u: typeof users.$inferSelect): AdminUserDto => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.platformRole === "infrastructure_admin" ? "server_admin" : "customer",
  status: u.userStatus === "disabled" ? "disabled" : "active",
  totpEnabled: u.totpEnabledAt != null,
  mustChangePassword: u.mustChangePassword,
  lockedUntil: u.lockedUntil ? u.lockedUntil.toISOString() : null,
  createdAt: u.createdAt.toISOString(),
});

@Controller("v1/admin")
export class AdminUsersController {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(AuthzContextService) private readonly authz: AuthzContextService,
    @Inject(OidcService) private readonly oidc: OidcService,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
  ) {}

  #guard(req: FastifyRequest, targetId: string | null) {
    return requireServerAdmin(this.authz, req, targetId);
  }

  async #findUser(userId: string) {
    const [user] = await this.dbClient.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new ControlPlaneError("NOT_FOUND", "User not found.");
    return user;
  }

  @Get("users")
  public async listUsers(@Req() req: FastifyRequest): Promise<{ data: AdminUserDto[] }> {
    await this.#guard(req, null);
    const rows = await this.dbClient.db.select().from(users).orderBy(asc(users.createdAt));
    return { data: rows.map(toDto) };
  }

  @Post("customer-account")
  @HttpCode(HttpStatus.CREATED)
  public async createCustomerAccount(
    @Req() req: FastifyRequest,
    @Body() raw: unknown,
  ): Promise<{ data: { organizationId: string; userId: string; temporaryPassword: string } }> {
    const auth = await this.#guard(req, null);
    const body = CreateCustomerAccountInputSchema.parse(raw ?? {});
    const db = this.dbClient.db;

    const [host] = await db.select().from(hosts).limit(1);
    if (!host) throw new ControlPlaneError("NOT_FOUND", "Installation has not been set up.");

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);
    const organizationId = `org_${randomUUID()}`;
    const userId = `usr_${randomUUID()}`;
    const membershipId = `mem_${randomUUID()}`;
    // Random suffix keeps the unique slug clear of the internal platform-ops org.
    const slug = `${body.organizationName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "customer"}-${randomUUID().slice(0, 6)}`;

    try {
      await db.transaction(async (tx) => {
        const [dup] = await tx.select({ id: users.id }).from(users).where(eq(users.email, body.ownerEmail)).limit(1);
        if (dup) throw new ControlPlaneError("VALIDATION_ERROR", "A user with this email already exists.");
        await tx.insert(organizations).values({
          id: organizationId,
          platformInstallationId: host.platformInstallationId,
          name: body.organizationName,
          slug,
        });
        // Nested call becomes a savepoint; the dedicated admission is the one-customer rule.
        await allocateHostTransactional(tx as unknown as HostingPanelDatabase, {
          hostId: host.id,
          organizationId,
          hostingMode: "dedicated",
          actorId: auth.user.id,
        });
        await tx.insert(users).values({
          id: userId,
          email: body.ownerEmail,
          name: body.ownerName,
          passwordHash,
          mustChangePassword: true,
        });
        await tx.insert(memberships).values({ id: membershipId, organizationId, userId });
        await tx.insert(membershipRoles).values({
          id: `mrl_${randomUUID()}`,
          membershipId,
          roleId: CUSTOMER_OWNER_ROLE_ID,
        });
      });
    } catch (err) {
      const code = (err as { code?: ErrorCode }).code;
      if (err instanceof ControlPlaneError || typeof code !== "string" || !/^[A-Z_]+$/.test(code)) throw err;
      throw new ControlPlaneError(code, (err as Error).message);
    }

    await this.authz.recordAudit(auth, req, {
      organizationId,
      action: "admin.customer_account.create",
      targetType: "user",
      targetId: userId,
      details: { ownerEmail: body.ownerEmail },
    });
    return { data: { organizationId, userId, temporaryPassword } };
  }

  @Post("users/:userId/reset-password")
  @HttpCode(HttpStatus.OK)
  public async resetPassword(
    @Req() req: FastifyRequest,
    @Param("userId") userId: string,
  ): Promise<{ data: { temporaryPassword: string } }> {
    const auth = await this.#guard(req, userId);
    const user = await this.#findUser(userId);
    if (user.platformRole === "infrastructure_admin") {
      throw new ControlPlaneError("PERMISSION_DENIED", "Server admin passwords can only be reset from the CLI.");
    }
    const { temporaryPassword } = await resetUserPassword(this.dbClient.db, { email: user.email });
    await this.authz.recordAudit(auth, req, { action: "admin.user.reset_password", targetType: "user", targetId: userId });
    return { data: { temporaryPassword } };
  }

  @Post("users/:userId/reset-totp")
  @HttpCode(HttpStatus.NO_CONTENT)
  public async resetTotp(@Req() req: FastifyRequest, @Param("userId") userId: string): Promise<void> {
    const auth = await this.#guard(req, userId);
    const user = await this.#findUser(userId);
    if (user.platformRole === "infrastructure_admin") {
      throw new ControlPlaneError("PERMISSION_DENIED", "Server admin TOTP can only be reset from the CLI.");
    }
    await resetUserTotp(this.dbClient.db, this.config.secretsMasterKey, { email: user.email });
    await this.authz.recordAudit(auth, req, { action: "admin.user.reset_totp", targetType: "user", targetId: userId });
  }

  @Patch("users/:userId")
  public async updateStatus(
    @Req() req: FastifyRequest,
    @Param("userId") userId: string,
    @Body() raw: unknown,
  ): Promise<{ data: AdminUserDto }> {
    const auth = await this.#guard(req, userId);
    const { status } = StatusBody.parse(raw ?? {});
    if (status === "disabled" && userId === auth.user.id) {
      throw new ControlPlaneError("PERMISSION_DENIED", "You cannot disable your own account.");
    }
    await this.#findUser(userId);
    const [updated] = await this.dbClient.db
      .update(users)
      .set({ userStatus: status, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning();
    if (status === "disabled") await this.oidc.revokeAllSessionsForUser(userId);
    await this.authz.recordAudit(auth, req, {
      action: "admin.user.status",
      targetType: "user",
      targetId: userId,
      details: { status },
    });
    return { data: toDto(updated!) };
  }
}
