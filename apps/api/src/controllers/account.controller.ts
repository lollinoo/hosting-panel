import { Body, Controller, HttpCode, HttpStatus, Inject, Patch, Post, Req } from "@nestjs/common";
import { encryptSecretAesGcm, eq, users, type DatabaseClient } from "@hosting-panel/database";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { AuthzContextService, type AuthenticatedRequestContext } from "../auth/authz-context.service.js";
import { OidcService } from "../auth/oidc.service.js";
import { assertPasswordPolicy, hashPassword, verifyPassword } from "../auth/password.js";
import { generateTotpSecret, buildOtpauthUri } from "../auth/totp.js";
import { checkUserTotp, saveTotpStep } from "../auth/totp-secret.js";
import { ControlPlaneError } from "../common/control-plane.error.js";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  DATABASE_CLIENT_TOKEN,
  type ControlPlaneRuntimeConfig,
} from "../tokens.js";

const PasswordBody = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(1) });
const EnableBody = z.object({ code: z.string().min(1) });
const DisableBody = z.object({ password: z.string().min(1), code: z.string().min(1) });
const LocaleBody = z.object({ locale: z.enum(["it", "en"]) });

const BAD_PASSWORD = "Password non corretta.";
const BAD_CODE = "Codice di verifica non valido.";

@Controller("v1/me")
export class AccountController {
  public constructor(
    @Inject(AuthzContextService) private readonly authz: AuthzContextService,
    @Inject(OidcService) private readonly oidc: OidcService,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
  ) {}

  @Post("password")
  @HttpCode(HttpStatus.NO_CONTENT)
  public async changePassword(@Req() req: FastifyRequest, @Body() raw: unknown): Promise<void> {
    const { auth, user } = await this.load(req);
    const body = PasswordBody.parse(raw ?? {});
    if (!user.passwordHash || !(await verifyPassword(body.currentPassword, user.passwordHash))) {
      await this.fail(auth, req, "account.password.change", "INVALID_CREDENTIALS", BAD_PASSWORD);
    }
    assertPasswordPolicy(body.newPassword);
    await this.dbClient.db
      .update(users)
      .set({ passwordHash: await hashPassword(body.newPassword), mustChangePassword: false })
      .where(eq(users.id, user.id));
    await this.oidc.revokeAllSessionsForUser(user.id, auth.claims.jti);
    await this.authz.recordAudit(auth, req, { action: "account.password.change", targetType: "user", targetId: user.id });
  }

  @Post("totp/setup")
  @HttpCode(HttpStatus.OK)
  public async setupTotp(
    @Req() req: FastifyRequest,
  ): Promise<{ data: { secretBase32: string; otpauthUri: string } }> {
    const { auth, user } = await this.load(req);
    if (user.totpEnabledAt !== null) {
      throw new ControlPlaneError("VALIDATION_ERROR", "L'autenticazione a due fattori è già attiva.");
    }
    const secret = generateTotpSecret();
    const env = encryptSecretAesGcm({
      plaintext: secret,
      masterKey: this.config.secretsMasterKey,
      organizationId: "platform",
      siteId: null,
      secretKey: `totp:${user.id}`,
    });
    await this.dbClient.db
      .update(users)
      .set({
        totpCiphertextBase64: env.ciphertextBase64,
        totpIvBase64: env.ivBase64,
        totpAuthTagBase64: env.authTagBase64,
        totpEnabledAt: null,
        totpLastStep: null,
      })
      .where(eq(users.id, user.id));
    await this.authz.recordAudit(auth, req, { action: "account.totp.setup", targetType: "user", targetId: user.id });
    return { data: { secretBase32: secret, otpauthUri: buildOtpauthUri(secret, user.email, "Hosting Panel") } };
  }

  @Post("totp/enable")
  @HttpCode(HttpStatus.NO_CONTENT)
  public async enableTotp(@Req() req: FastifyRequest, @Body() raw: unknown): Promise<void> {
    const { auth, user } = await this.load(req);
    const body = EnableBody.parse(raw ?? {});
    if (user.totpEnabledAt !== null) {
      throw new ControlPlaneError("VALIDATION_ERROR", "L'autenticazione a due fattori è già attiva.");
    }
    const result = checkUserTotp(user, body.code, Date.now(), this.config.secretsMasterKey);
    if (!result.ok || !(await saveTotpStep(this.dbClient.db, user.id, result.step, { totpEnabledAt: new Date() }))) {
      await this.fail(auth, req, "account.totp.enable", "TOTP_INVALID", BAD_CODE);
    }
    await this.authz.recordAudit(auth, req, { action: "account.totp.enable", targetType: "user", targetId: user.id });
  }

  @Post("totp/disable")
  @HttpCode(HttpStatus.NO_CONTENT)
  public async disableTotp(@Req() req: FastifyRequest, @Body() raw: unknown): Promise<void> {
    const { auth, user } = await this.load(req);
    const body = DisableBody.parse(raw ?? {});
    if (user.platformRole === "infrastructure_admin") {
      await this.fail(auth, req, "account.totp.disable", "PERMISSION_DENIED", "Gli amministratori devono mantenere l'autenticazione a due fattori.");
    }
    if (!user.passwordHash || !(await verifyPassword(body.password, user.passwordHash))) {
      await this.fail(auth, req, "account.totp.disable", "INVALID_CREDENTIALS", BAD_PASSWORD);
    }
    const result = user.totpEnabledAt
      ? checkUserTotp(user, body.code, Date.now(), this.config.secretsMasterKey)
      : ({ ok: false } as const);
    const cleared = {
      totpCiphertextBase64: null,
      totpIvBase64: null,
      totpAuthTagBase64: null,
      totpEnabledAt: null,
      totpLastStep: null,
      totpFailedCount: 0,
    };
    if (!result.ok || !(await saveTotpStep(this.dbClient.db, user.id, result.step, cleared))) {
      await this.fail(auth, req, "account.totp.disable", "TOTP_INVALID", BAD_CODE);
    }
    await this.authz.recordAudit(auth, req, { action: "account.totp.disable", targetType: "user", targetId: user.id });
  }

  @Patch("locale")
  @HttpCode(HttpStatus.NO_CONTENT)
  public async setLocale(@Req() req: FastifyRequest, @Body() raw: unknown): Promise<void> {
    const { auth, user } = await this.load(req);
    const { locale } = LocaleBody.parse(raw ?? {});
    await this.dbClient.db.update(users).set({ locale }).where(eq(users.id, user.id));
    await this.authz.recordAudit(auth, req, {
      action: "account.locale.update",
      targetType: "user",
      targetId: user.id,
      details: { locale },
    });
  }

  private async load(req: FastifyRequest) {
    const auth = await this.authz.authenticateRequest(req);
    const [user] = await this.dbClient.db.select().from(users).where(eq(users.id, auth.user.id)).limit(1);
    if (!user) throw new ControlPlaneError("UNAUTHENTICATED", "User account is not active.");
    return { auth, user };
  }

  private async fail(
    auth: AuthenticatedRequestContext,
    req: FastifyRequest,
    action: string,
    code: "INVALID_CREDENTIALS" | "TOTP_INVALID" | "PERMISSION_DENIED",
    message: string,
  ): Promise<never> {
    await this.authz.recordAudit(auth, req, {
      action,
      targetType: "user",
      targetId: auth.user.id,
      details: { outcome: "failed", reason: code },
    });
    throw new ControlPlaneError(code, message);
  }
}
