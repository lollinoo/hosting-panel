import { and, eq, sql, users, type DatabaseClient } from "@hosting-panel/database";

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;

/**
 * One atomic statement, only while unlocked: count the attempt; the 5th locks for 15 minutes
 * and resets the counter. Returns false (no row) when the account is locked.
 */
export async function reservePasswordAttempt(db: DatabaseClient["db"], userId: string): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const lockIso = new Date(Date.now() + LOCK_MS).toISOString();
  const next = sql`${users.failedLoginCount} + 1`;
  const rows = await db
    .update(users)
    .set({
      failedLoginCount: sql`CASE WHEN ${next} >= ${MAX_FAILURES} THEN 0 ELSE ${next} END`,
      lockedUntil: sql`CASE WHEN ${next} >= ${MAX_FAILURES} THEN ${lockIso}::timestamptz ELSE ${users.lockedUntil} END`,
      // Runs only while unlocked, so a TOTP count >= 5 is left over from an expired TOTP lock;
      // clear it when locking, or it would refuse the bypass of this password-caused lock.
      totpFailedCount: sql`CASE WHEN ${next} >= ${MAX_FAILURES} AND ${users.totpFailedCount} >= ${MAX_FAILURES} THEN 0 ELSE ${users.totpFailedCount} END`,
    })
    .where(
      and(
        eq(users.id, userId),
        sql`(${users.lockedUntil} IS NULL OR ${users.lockedUntil} <= ${nowIso}::timestamptz)`,
      ),
    )
    .returning({ id: users.id });
  return rows.length > 0;
}

/**
 * Separate TOTP counter, counted even under a password-caused lock. After a TOTP lock has
 * passed it starts fresh; the 5th guess locks for 15 minutes. Returns false (no row) while a
 * TOTP-caused lock is active, so at most 5 codes are ever verified per lock window.
 */
export async function reserveTotpAttempt(db: DatabaseClient["db"], userId: string): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const lockIso = new Date(Date.now() + LOCK_MS).toISOString();
  const expired = sql`(${users.lockedUntil} IS NULL OR ${users.lockedUntil} <= ${nowIso}::timestamptz)`;
  const next = sql`CASE WHEN ${expired} AND ${users.totpFailedCount} >= ${MAX_FAILURES} THEN 1 ELSE ${users.totpFailedCount} + 1 END`;
  const rows = await db
    .update(users)
    .set({
      totpFailedCount: next,
      lockedUntil: sql`CASE WHEN ${next} >= ${MAX_FAILURES} THEN GREATEST(${users.lockedUntil}, ${lockIso}::timestamptz) ELSE ${users.lockedUntil} END`,
    })
    .where(and(eq(users.id, userId), sql`(${expired} OR ${users.totpFailedCount} < ${MAX_FAILURES})`))
    .returning({ id: users.id });
  return rows.length > 0;
}
