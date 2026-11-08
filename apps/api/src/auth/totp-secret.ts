import {
  and,
  decryptSecretAesGcm,
  eq,
  isNull,
  lt,
  or,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import { verifyTotp } from "./totp.js";

type TotpUser = Pick<
  typeof users.$inferSelect,
  "id" | "totpCiphertextBase64" | "totpIvBase64" | "totpAuthTagBase64" | "totpLastStep"
>;

/** Decrypts the user's stored TOTP secret and checks the code. A corrupt secret is a failed code, never a throw. */
export function checkUserTotp(
  user: TotpUser,
  code: string,
  now: number,
  masterKey: Buffer,
): { ok: true; step: number } | { ok: false } {
  try {
    const secret = decryptSecretAesGcm({
      ciphertextBase64: user.totpCiphertextBase64 ?? "",
      ivBase64: user.totpIvBase64 ?? "",
      authTagBase64: user.totpAuthTagBase64 ?? "",
      masterKey,
      organizationId: "platform",
      siteId: null,
      secretKey: `totp:${user.id}`,
    });
    return verifyTotp(secret, code, now, user.totpLastStep);
  } catch {
    return { ok: false };
  }
}

/** Conditional step save (plus `extra` columns): of two concurrent uses of one code, only one matches. */
export async function saveTotpStep(
  db: DatabaseClient["db"],
  userId: string,
  step: number,
  extra: Partial<typeof users.$inferInsert> = {},
): Promise<boolean> {
  const saved = await db
    .update(users)
    .set({ totpLastStep: step, ...extra })
    .where(and(eq(users.id, userId), or(isNull(users.totpLastStep), lt(users.totpLastStep, step))))
    .returning({ id: users.id });
  return saved.length > 0;
}
