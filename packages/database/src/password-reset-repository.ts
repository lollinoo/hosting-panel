import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DatabaseExecutor, HostingPanelDatabase } from "./client.js";

/** Stores a reset token hash unless a rate limit is hit; false when refused. */
export async function createPasswordResetToken(
  db: HostingPanelDatabase,
  input: { userId: string; tokenHash: string },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    // The user row lock serialises two requests for one account, so its limit of 3 holds.
    const user = await tx.execute(sql`SELECT id FROM users WHERE id = ${input.userId} FOR UPDATE`);
    if (user.rows.length === 0) return false;
    const id = `prt_${randomUUID().replace(/-/g, "")}`;
    // The retire is limited to the last hour so it never touches a row the purge deletes.
    const inserted = await tx.execute(sql`
      WITH purged AS (DELETE FROM password_reset_tokens WHERE created_at < now() - interval '1 hour'),
      allowed AS (SELECT 1 WHERE
        (SELECT count(*) FROM password_reset_tokens WHERE user_id = ${input.userId} AND created_at >= now() - interval '1 hour') < 3
        AND (SELECT count(*) FROM password_reset_tokens WHERE created_at >= now() - interval '1 hour') < 20),
      retired AS (UPDATE password_reset_tokens SET used_at = now()
        WHERE user_id = ${input.userId} AND used_at IS NULL AND created_at >= now() - interval '1 hour' AND EXISTS (SELECT 1 FROM allowed))
      INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
      SELECT ${id}, ${input.userId}, ${input.tokenHash}, now() + interval '30 minutes' FROM allowed
      RETURNING id`);
    return inserted.rows.length === 1;
  });
}

/** Marks an unused, unexpired token used once; returns its user id or null. */
export async function usePasswordResetToken(tx: DatabaseExecutor, tokenHash: string): Promise<string | null> {
  // Lock order as in createPasswordResetToken: the user row first, then the token rows, so the two cannot deadlock.
  await tx.execute(sql`
    SELECT id FROM users WHERE id = (SELECT user_id FROM password_reset_tokens WHERE token_hash = ${tokenHash}) FOR UPDATE`);
  const res = await tx.execute<{ user_id: string }>(sql`
    UPDATE password_reset_tokens SET used_at = now()
    WHERE token_hash = ${tokenHash} AND used_at IS NULL AND expires_at > now()
    RETURNING user_id`);
  return res.rows[0]?.user_id ?? null;
}
