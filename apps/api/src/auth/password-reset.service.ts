import { createHash, randomBytes } from "node:crypto";
import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import {
  and,
  appendAuditEvent,
  createPasswordResetToken,
  eq,
  hosts,
  isNull,
  usePasswordResetToken,
  userSessions,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import { ControlPlaneError } from "../common/control-plane.error.js";
import { MailRelayService } from "../mail/mail-relay.service.js";
import { DATABASE_CLIENT_TOKEN } from "../tokens.js";
import { passwordResetLockFields } from "./attempt-limits.js";
import { assertPasswordPolicy, hashPassword } from "./password.js";

// R179 2.2: the route answers before its work, so this is what holds a flood back.
const MAX_PENDING = 32;

const sha256 = (token: string): string => createHash("sha256").update(token).digest("hex");
const invalid = () => new ControlPlaneError("PASSWORD_RESET_INVALID", "This reset link is not valid any more. Ask for a new one.");

/** Password reset by mail, for active customer accounts only. */
@Injectable()
export class PasswordResetService implements OnModuleDestroy {
  readonly #pending = new Set<Promise<void>>();

  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(MailRelayService) private readonly mailRelay: MailRelayService,
  ) {}

  /** Schedules the delivery after the response and returns at once; over the bound it drops the request silently. */
  public request(email: string): void {
    if (this.#pending.size >= MAX_PENDING) return;
    const work: Promise<void> = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.deliver(email))
      .catch((err: unknown) => {
        const code = (err as { code?: unknown } | null)?.code ?? "INTERNAL_ERROR";
        console.warn(JSON.stringify({ event: "password_reset_failed", code }));
      })
      .finally(() => this.#pending.delete(work));
    this.#pending.add(work);
  }

  /** Makes a token and mails the link when the address is an active customer's; otherwise does nothing. */
  public async deliver(email: string): Promise<void> {
    const db = this.dbClient.db;
    const [user] = await db
      .select({ id: users.id, email: users.email, locale: users.locale, status: users.userStatus, role: users.platformRole })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (!user || user.status !== "active" || user.role !== null) return;
    const token = randomBytes(32).toString("base64url");
    if (!(await createPasswordResetToken(db, { userId: user.id, tokenHash: sha256(token) }))) return;
    // The link's host comes only from the installation's saved host name, never from the request.
    const [host] = await db.select({ hostname: hosts.hostname }).from(hosts).limit(1);
    const delivery = host
      ? await this.mailRelay.sendPanelMail({
          kind: "password_reset",
          to: user.email,
          locale: user.locale,
          link: `https://${host.hostname}/reset-password#${token}`,
        })
      : "not_sent";
    await appendAuditEvent(db, {
      actorId: null,
      actorType: "system",
      action: "auth.password_reset.requested",
      targetType: "user",
      targetId: user.id,
      details: { delivery },
    });
  }

  /** Sets the new password with a token from the mail and ends every session of the account. */
  public async confirm(token: string, newPassword: string): Promise<void> {
    // Policy and scrypt first: a weak password does not use the token up, and no lock is held during scrypt.
    assertPasswordPolicy(newPassword);
    const passwordHash = await hashPassword(newPassword);
    const tokenHash = sha256(token);
    await this.dbClient.db.transaction(async (tx) => {
      const userId = await usePasswordResetToken(tx, tokenHash);
      if (userId === null) throw invalid();
      const now = new Date();
      // An account disabled or made an administrator since the request is refused; the rollback keeps the token unused.
      const updated = await tx
        .update(users)
        .set({ passwordHash, mustChangePassword: false, ...passwordResetLockFields, updatedAt: now })
        .where(and(eq(users.id, userId), eq(users.userStatus, "active"), isNull(users.platformRole)))
        .returning({ id: users.id });
      if (updated.length === 0) throw invalid();
      await tx
        .update(userSessions)
        .set({ revokedAt: now })
        .where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt)));
      await appendAuditEvent(tx, {
        actorId: userId,
        actorType: "user",
        action: "auth.password_reset.completed",
        targetType: "user",
        targetId: userId,
        details: {},
      });
    });
  }

  /** Resolves when no delivery is pending. */
  public async idle(): Promise<void> {
    while (this.#pending.size > 0) await Promise.all(this.#pending);
  }

  public async onModuleDestroy(): Promise<void> {
    await this.idle();
  }
}
